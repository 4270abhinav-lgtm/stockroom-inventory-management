# Stockroom - Inventory Management System

Stockroom is a lightweight inventory app for a single store or warehouse. It uses plain HTML, CSS, JavaScript, Python's standard library, and SQLite. It does not need package installation or an internet connection to run locally.

## Run the app

On Windows, double-click `start.bat`, then open <http://127.0.0.1:8000> in a modern browser. Keep the server window open while using the app. The first run creates `data/inventory.db` automatically.

## Main features

- Add, edit, search, filter, and delete products
- Track SKU, category, unit cost, quantity, and reorder level
- Record stock received and stock removed, including a reason
- View total products, units in stock, stock value, and low or out-of-stock items
- Review recent stock movements and the full movement history
- Store products and stock movements in SQLite
- Export the product list to CSV
- Download a JSON backup containing products and movement history, and restore it later
- Validate duplicate SKUs and prevent stock from being removed below zero

## Save and backup behavior

The database is a local file on the computer running the app. It is not shared across devices or users. Use **Backup** regularly to download a JSON copy. **Restore** replaces the current inventory with the contents of a valid Stockroom backup. CSV export contains the product list, not movement history. The local server listens only on this computer.

## Project limits

This version is designed as a simple single-computer project. It does not include accounts, cloud sync, or automated backups. A multi-user online deployment would need a hosted server and database, authentication, and a deployment setup.
