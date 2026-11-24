SHELL := /bin/bash
COMPOSE ?= podman-compose
IMAGE_TAG ?= latest

.PHONY: build up down restart logs ps health backup restore mock
build:
	$(COMPOSE) build

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f --tail=200

ps:
	$(COMPOSE) ps

health:
	curl -fsS "$${FM_PUBLIC_BASE_URL:-http://127.0.0.1:5266}/health"

backup:
	$(COMPOSE) exec -T api python scripts/backup.py --out /app/data/backups --keep 14

restore:
	@echo "用法：先解压备份到 ./data，再 make up"

mock:
	@echo "mock 模式请使用 deploy/env.example 的默认 provider（mock）并复制为 .env"
