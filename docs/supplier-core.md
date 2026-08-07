# Supplier-core data model

`Supplier` is the aggregate root of the crawler database.

## Invariants

1. A crawler record is persisted only after a valid supplier name has been parsed.
2. `Product.supplierId` is required. Seeds, equipment and fertilizers are not stored independently.
3. `SourceEvidence.supplierId` is required. Evidence always belongs to a supplier, while `productId` is optional.
4. `Image.supplierId` is required, including product images and favicons.
5. The crawler never creates placeholder suppliers such as `UNKNOWN`, `N/A` or `Chưa xác định`.
6. An official row containing a variety/fertilizer but no explicit supplier column is skipped. The raw page snapshot remains available for later parser review.

## Accepted official row

```text
STT | Tên giống          | Đơn vị đăng ký                  | Quyết định
1   | Cà chua Ruby F1    | Công ty TNHH Giống cây ABC     | 123/QĐ-TT
```

The crawler creates or updates the supplier first, then attaches the product and evidence.

## Rejected official row

```text
STT | Tên giống          | Quyết định
1   | Cà chua Ruby F1    | 123/QĐ-TT
```

No supplier can be identified, so no supplier, product or evidence document is written. The product name is never used as a fallback supplier name.

## Relationship

```text
Supplier (core)
├── Product[]
├── SourceEvidence[]
└── Image[]
```

The public API follows the same structure: products, evidence and images are returned through `GET /api/suppliers/:id`.
