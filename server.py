"""Local Stockroom web server and SQLite persistence layer."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
DB_DIR = ROOT / "data"
DB_PATH = DB_DIR / "inventory.db"
HOST = "127.0.0.1"
PORT = 8000
MAX_BODY = 5 * 1024 * 1024


def connect_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_db() -> None:
    DB_DIR.mkdir(exist_ok=True)
    with closing(connect_db()) as db:
        db.execute("PRAGMA journal_mode = WAL")
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
                sku TEXT NOT NULL DEFAULT '',
                category TEXT NOT NULL DEFAULT '',
                unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
                quantity INTEGER NOT NULL CHECK(quantity >= 0),
                reorder_level INTEGER NOT NULL CHECK(reorder_level >= 0)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS products_sku_unique
                ON products(lower(sku)) WHERE sku <> '';
            CREATE INDEX IF NOT EXISTS products_name_idx ON products(name);
            CREATE TABLE IF NOT EXISTS stock_movements (
                id TEXT PRIMARY KEY,
                product_id TEXT NOT NULL,
                product_name TEXT NOT NULL,
                movement_type TEXT NOT NULL CHECK(movement_type IN ('in', 'out')),
                quantity INTEGER NOT NULL CHECK(quantity > 0),
                reason TEXT NOT NULL DEFAULT '',
                occurred_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS movements_date_idx ON stock_movements(occurred_at);
            """
        )


def read_state(db: sqlite3.Connection) -> dict:
    products = [
        {
            "id": row["id"],
            "name": row["name"],
            "sku": row["sku"],
            "category": row["category"],
            "cost": row["unit_cost"],
            "quantity": row["quantity"],
            "reorderLevel": row["reorder_level"],
        }
        for row in db.execute("SELECT * FROM products ORDER BY name COLLATE NOCASE")
    ]
    movements = [
        {
            "id": row["id"],
            "productId": row["product_id"],
            "productName": row["product_name"],
            "type": row["movement_type"],
            "quantity": row["quantity"],
            "reason": row["reason"],
            "date": row["occurred_at"],
        }
        for row in db.execute("SELECT * FROM stock_movements ORDER BY occurred_at DESC, rowid DESC LIMIT 500")
    ]
    return {"products": products, "movements": movements}


def validate_state(payload: object) -> tuple[list[dict], list[dict]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("products"), list) or not isinstance(payload.get("movements"), list):
        raise ValueError("Request must include products and movements lists.")
    if len(payload["products"]) > 10000 or len(payload["movements"]) > 500:
        raise ValueError("This inventory exceeds the allowed record limit.")

    products: list[dict] = []
    ids: set[str] = set()
    skus: set[str] = set()
    for item in payload["products"]:
        if not isinstance(item, dict):
            raise ValueError("Each product must be an object.")
        product_id = str(item.get("id", ""))
        name = str(item.get("name", "")).strip()
        sku = str(item.get("sku", "")).strip()
        category = str(item.get("category", "")).strip()
        if not product_id or len(product_id) > 100 or not name or len(name) > 80:
            raise ValueError("Product ID and a name of 1 to 80 characters are required.")
        if len(sku) > 40 or len(category) > 40:
            raise ValueError("SKU and category must be 40 characters or fewer.")
        if product_id in ids:
            raise ValueError("Product IDs must be unique.")
        ids.add(product_id)
        sku_key = sku.casefold()
        if sku_key and sku_key in skus:
            raise ValueError(f"SKU {sku} is already in use.")
        if sku_key:
            skus.add(sku_key)
        cost = _number(item.get("cost"), "Unit cost")
        quantity = _integer(item.get("quantity"), "Quantity")
        reorder = _integer(item.get("reorderLevel"), "Reorder level")
        if cost < 0 or quantity < 0 or reorder < 0:
            raise ValueError("Unit cost, quantity, and reorder level cannot be negative.")
        products.append({"id": product_id, "name": name, "sku": sku, "category": category, "cost": cost, "quantity": quantity, "reorderLevel": reorder})

    movements: list[dict] = []
    movement_ids: set[str] = set()
    for item in payload["movements"]:
        if not isinstance(item, dict):
            raise ValueError("Each stock movement must be an object.")
        movement_id = str(item.get("id", ""))
        product_id = str(item.get("productId", ""))
        product_name = str(item.get("productName", "Deleted product"))[:80]
        movement_type = item.get("type")
        quantity = _integer(item.get("quantity"), "Movement quantity")
        reason = str(item.get("reason", ""))[:100]
        occurred_at = str(item.get("date", ""))
        if not movement_id or movement_id in movement_ids or len(movement_id) > 100:
            raise ValueError("Stock movement IDs must be present and unique.")
        if movement_type not in ("in", "out") or quantity <= 0 or not occurred_at or len(occurred_at) > 40:
            raise ValueError("Stock movement type, date, or quantity is invalid.")
        movement_ids.add(movement_id)
        movements.append({"id": movement_id, "productId": product_id, "productName": product_name, "type": movement_type, "quantity": quantity, "reason": reason, "date": occurred_at})
    return products, movements


def _number(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be a number.")
    try:
        result = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} must be a number.") from None
    if result != result or result in (float("inf"), float("-inf")):
        raise ValueError(f"{label} must be finite.")
    return result


def _integer(value: object, label: str) -> int:
    result = _number(value, label)
    if not result.is_integer():
        raise ValueError(f"{label} must be a whole number.")
    return int(result)


class StockroomHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def _send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _read_json(self) -> object:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid request size.") from None
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Request must be between 1 byte and 5 MB.")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("Request body must be valid JSON.") from None

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/api/state":
            try:
                with closing(connect_db()) as db:
                    self._send_json(200, read_state(db))
            except sqlite3.Error:
                self._send_json(500, {"error": "Could not read the inventory database."})
            return
        if urlparse(self.path).path.startswith("/api/"):
            self._send_json(404, {"error": "API route not found."})
            return
        super().do_GET()

    def do_PUT(self) -> None:
        if urlparse(self.path).path != "/api/state":
            self._send_json(404, {"error": "API route not found."})
            return
        try:
            products, movements = validate_state(self._read_json())
            with closing(connect_db()) as db:
                db.execute("BEGIN IMMEDIATE")
                db.execute("DELETE FROM stock_movements")
                db.execute("DELETE FROM products")
                db.executemany(
                    "INSERT INTO products (id, name, sku, category, unit_cost, quantity, reorder_level) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [(p["id"], p["name"], p["sku"], p["category"], p["cost"], p["quantity"], p["reorderLevel"]) for p in products],
                )
                db.executemany(
                    "INSERT INTO stock_movements (id, product_id, product_name, movement_type, quantity, reason, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [(m["id"], m["productId"], m["productName"], m["type"], m["quantity"], m["reason"], m["date"]) for m in movements],
                )
                db.commit()
                self._send_json(200, {"ok": True})
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
        except sqlite3.IntegrityError:
            self._send_json(409, {"error": "The change conflicts with existing product data."})
        except sqlite3.Error:
            self._send_json(500, {"error": "Could not save the inventory database."})


if __name__ == "__main__":
    initialize_db()
    server = ThreadingHTTPServer((HOST, PORT), StockroomHandler)
    print(f"Stockroom is running at http://{HOST}:{PORT}")
    print(f"SQLite database: {DB_PATH}")
    print("Keep this window open while using Stockroom. Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStockroom stopped.")
    finally:
        server.server_close()
