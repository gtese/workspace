"""轻量 schema 迁移：create_all 不会给已存在的表加列，这里补齐新增字段。"""

from __future__ import annotations

import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

log = logging.getLogger(__name__)

# 表 -> [(列名, DDL 类型)]
ADDED_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "users": [
        ("feishu_open_id", "VARCHAR(64) DEFAULT ''"),
        ("feishu_union_id", "VARCHAR(64) DEFAULT ''"),
        ("feishu_tenant_key", "VARCHAR(64) DEFAULT ''"),
        ("feishu_refresh_token", "TEXT DEFAULT ''"),
        ("feishu_access_token", "TEXT DEFAULT ''"),
        ("feishu_token_exp", "FLOAT DEFAULT 0"),
        ("feishu_app_slug", "VARCHAR(40) DEFAULT ''"),
        ("ops_role", "VARCHAR(20) DEFAULT ''"),
    ],
    "orgs": [
        ("feishu_tenant_key", "VARCHAR(64) DEFAULT ''"),
        ("feishu_refresh_token", "TEXT DEFAULT ''"),
        ("feishu_app_slug", "VARCHAR(40) DEFAULT ''"),
        ("ops_role", "VARCHAR(20) DEFAULT ''"),
    ],
    "recordings": [
        ("org_id", "VARCHAR(32) DEFAULT ''"),
        ("owner_user_id", "VARCHAR(32) DEFAULT ''"),
        ("source", "VARCHAR(20) DEFAULT 'web'"),
    ],
}

INDEXES: list[tuple[str, str, str]] = [
    ("ix_users_feishu_open_id", "users", "feishu_open_id"),
    ("ix_users_feishu_tenant_key", "users", "feishu_tenant_key"),
    ("ix_orgs_feishu_tenant_key", "orgs", "feishu_tenant_key"),
    ("ix_recordings_org_id", "recordings", "org_id"),
]


def ensure_schema(engine: Engine) -> list[str]:
    """返回本次实际执行的迁移描述，便于启动日志观察。"""
    applied: list[str] = []
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            if table not in tables:
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in columns:
                if name in existing:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                applied.append(f"{table}.{name}")
        for index, table, column in INDEXES:
            if table not in tables:
                continue
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS {index} ON {table} ({column})"))
    if applied:
        log.info("schema 迁移：%s", ", ".join(applied))
    return applied
