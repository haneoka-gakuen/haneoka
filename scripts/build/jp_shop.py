"""JP native shop provenance and platform SKU metadata from MasterShop."""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterable


def _purchase_id(value: Any) -> str | None:
    if value is None or value == "" or value == "null":
        return None
    if not isinstance(value, str) or value != value.strip():
        raise ValueError("jp-shop-invalid-purchase-id")
    return value


def bind_jp_shop_metadata(
    document: dict[str, Any], rows: Iterable[dict[str, Any]]
) -> dict[str, Any]:
    """Retain native IDs/grants while keeping Master prices distinct from SDK prices.

    Call only with a JP document and MasterShop from the same source. This
    adapter does not query Apple or Google; their localized prices remain
    explicitly unavailable until a platform product query provides them.
    """
    native: dict[str, dict[str, Any]] = {}
    for row in rows:
        identity = row.get("_id")
        if type(identity) is not int or identity <= 0 or str(identity) in native:
            raise ValueError("jp-shop-invalid-native-id")
        native[str(identity)] = row
    entries = document.get("entries")
    if not isinstance(entries, dict) or set(entries) != set(native):
        raise ValueError("jp-shop-native-lineup-mismatch")
    result = deepcopy(document)
    for identity, entry in result["entries"].items():
        row = native[identity]
        if entry.get("id") != identity or entry.get("kind") != "shop":
            raise ValueError("jp-shop-entry-identity-mismatch")
        payment_type, price = row.get("_paymentType"), row.get("_price")
        if type(payment_type) is not int or type(price) is not int or price < 0:
            raise ValueError("jp-shop-invalid-native-payment")
        apple = _purchase_id(row.get("_appStorePurchaseId"))
        google = _purchase_id(row.get("_googlePlayPurchaseId"))
        cash = payment_type == 16
        entry.update(sourceTable="MasterShop", shopId=row["_id"], identityNamespace="native-shop")
        payment = entry.get("payment")
        if not isinstance(payment, dict):
            raise ValueError("jp-shop-missing-payment")
        payment.update(paymentType=payment_type, storePurchase=cash)
        if cash:
            payment["price"] = None
            payment["currency"] = []
            payment["currencyImage"] = ""
            payment.pop("prices", None)
            payment["masterPrice"] = {
                "value": price, "sourceTable": "MasterShop", "sourceField": "_price",
                "currency": None, "taxIncluded": None,
            }
            payment["storefront"] = {
                platform: {
                    "productId": sku, "sourceTable": "MasterShop", "sourceField": field,
                    "formattedPrice": None, "currency": None, "taxIncluded": None,
                    "priceStatus": "unqueried",
                }
                for platform, sku, field in (
                    ("apple", apple, "_appStorePurchaseId"),
                    ("googlePlay", google, "_googlePlayPurchaseId"),
                )
            }
        else:
            payment["price"] = price
    return result
