"""Stockroom API — warehouse stock + movement ledger over plain Postgres.

Runs as a Vercel Python function (api/index handles every /api/* route via
the rewrite in vercel.json) or locally with:

    DATABASE_URL=postgresql://localhost/stockroom uvicorn api.index:app --port 8100

Locally the repo root is also served statically so the dashboard works
without a separate web server.
"""

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import bcrypt
import jwt
import psycopg
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://localhost/stockroom")
APP_SECRET = os.environ.get("APP_SECRET", "dev-secret-change-me")
TOKEN_TTL_HOURS = 12

app = FastAPI(title="stockroom-api")
api = APIRouter(prefix="/api")


def _connect():
    return psycopg.connect(DATABASE_URL)


def _issue_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_TTL_HOURS),
    }
    return jwt.encode(payload, APP_SECRET, algorithm="HS256")


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="not signed in")
    try:
        payload = jwt.decode(
            authorization.removeprefix("Bearer "), APP_SECRET, algorithms=["HS256"]
        )
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="session expired or invalid")
    return {"id": payload["sub"], "email": payload["email"]}


class LoginRequest(BaseModel):
    email: str
    password: str


class MovementRequest(BaseModel):
    warehouse_id: int
    sku_id: int
    movement_type: str = Field(pattern="^(receipt|shipment|adjustment)$")
    quantity: int
    reference_code: str | None = None


@api.post("/auth/login")
def login(body: LoginRequest):
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select id, email, encrypted_password from auth.users where email = %s",
            (body.email,),
        )
        row = cur.fetchone()
        if row is None or not bcrypt.checkpw(body.password.encode(), row[2].encode()):
            raise HTTPException(status_code=401, detail="bad email or password")
        cur.execute(
            "update auth.users set last_sign_in_at = now() where id = %s", (row[0],)
        )
        conn.commit()
    return {"token": _issue_token(str(row[0]), row[1]), "email": row[1]}


@api.get("/me")
def me(user: dict = Depends(current_user)):
    return user


@api.get("/warehouses")
def list_warehouses():
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select w.id, w.code, w.name, w.region,
                   count(sl.id) as skus_stocked,
                   count(sl.id) filter (
                     where sl.quantity_on_hand <= sl.reorder_point
                   ) as low_stock
            from public.warehouses w
            left join public.stock_levels sl on sl.warehouse_id = w.id
            group by w.id
            order by w.code
            """
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "code": r[1],
            "name": r[2],
            "region": r[3],
            "skus_stocked": r[4],
            "low_stock": r[5],
        }
        for r in rows
    ]


@api.get("/warehouses/{warehouse_id}/stock")
def warehouse_stock(warehouse_id: int):
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select s.id, s.sku_code, s.name, s.category,
                   sl.quantity_on_hand, sl.reorder_point, sl.updated_at
            from public.stock_levels sl
            join public.skus s on s.id = sl.sku_id
            where sl.warehouse_id = %s
            order by s.sku_code
            """,
            (warehouse_id,),
        )
        rows = cur.fetchall()
    if not rows:
        raise HTTPException(status_code=404, detail="warehouse not found or empty")
    return [
        {
            "sku_id": r[0],
            "sku_code": r[1],
            "name": r[2],
            "category": r[3],
            "quantity_on_hand": r[4],
            "reorder_point": r[5],
            "updated_at": r[6].isoformat(),
            "low": r[4] <= r[5],
        }
        for r in rows
    ]


@api.get("/movements")
def recent_movements(limit: int = 40):
    limit = max(1, min(limit, 200))
    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            select m.id, w.code, s.sku_code, m.movement_type, m.quantity,
                   m.reference_code, m.occurred_at, u.email
            from public.movements m
            join public.warehouses w on w.id = m.warehouse_id
            join public.skus s on s.id = m.sku_id
            left join auth.users u on u.id = m.recorded_by
            order by m.occurred_at desc, m.id desc
            limit %s
            """,
            (limit,),
        )
        rows = cur.fetchall()
    return [
        {
            "id": r[0],
            "warehouse_code": r[1],
            "sku_code": r[2],
            "movement_type": r[3],
            "quantity": r[4],
            "reference_code": r[5],
            "occurred_at": r[6].isoformat(),
            "recorded_by": r[7],
        }
        for r in rows
    ]


@api.post("/movements", status_code=201)
def record_movement(body: MovementRequest, user: dict = Depends(current_user)):
    if body.movement_type in ("receipt", "shipment") and body.quantity <= 0:
        raise HTTPException(status_code=422, detail="quantity must be positive")
    if body.movement_type == "adjustment" and body.quantity == 0:
        raise HTTPException(status_code=422, detail="adjustment cannot be zero")

    # signed delta applied to the stock level
    delta = -body.quantity if body.movement_type == "shipment" else body.quantity

    with _connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select 1 from public.warehouses where id = %s", (body.warehouse_id,)
        )
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="warehouse not found")
        cur.execute("select 1 from public.skus where id = %s", (body.sku_id,))
        if cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="sku not found")

        cur.execute(
            """
            insert into public.stock_levels (warehouse_id, sku_id, quantity_on_hand)
            values (%s, %s, 0)
            on conflict (warehouse_id, sku_id) do nothing
            """,
            (body.warehouse_id, body.sku_id),
        )
        cur.execute(
            """
            update public.stock_levels
            set quantity_on_hand = quantity_on_hand + %s
            where warehouse_id = %s and sku_id = %s and quantity_on_hand + %s >= 0
            returning quantity_on_hand, reorder_point
            """,
            (delta, body.warehouse_id, body.sku_id, delta),
        )
        updated = cur.fetchone()
        if updated is None:
            conn.rollback()
            raise HTTPException(status_code=409, detail="insufficient stock on hand")

        cur.execute(
            """
            insert into public.movements
              (warehouse_id, sku_id, movement_type, quantity,
               recorded_by, reference_code)
            values (%s, %s, %s, %s, %s, %s)
            returning id, occurred_at
            """,
            (
                body.warehouse_id,
                body.sku_id,
                body.movement_type,
                delta,
                user["id"],
                body.reference_code,
            ),
        )
        movement_id, occurred_at = cur.fetchone()
        conn.commit()

    return {
        "id": movement_id,
        "occurred_at": occurred_at.isoformat(),
        "quantity_on_hand": updated[0],
        "low": updated[0] <= updated[1],
    }


app.include_router(api)

# The dashboard is served by the app itself, everywhere: locally, on the
# AWS composite, and on Vercel — whose FastAPI runtime routes every request
# to the app and promotes StaticFiles mounts to its CDN at build time. Only
# assets/ is mounted (never the repo root, which would publish db/ and api/).
ROOT = Path(__file__).resolve().parent.parent
app.mount("/assets", StaticFiles(directory=ROOT / "assets"), name="assets")


@app.get("/", include_in_schema=False)
def dashboard():
    return FileResponse(ROOT / "index.html")
