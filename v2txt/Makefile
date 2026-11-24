SHELL := /bin/bash
COMPOSE ?= docker compose
IMAGE_TAG ?= latest
PORT ?= 8080

.PHONY: build up down restart logs ps health shell backup restore admin lint test
build:
	$(COMPOSE) build

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) restart

logs:
	$(COMPOSE) logs -f --tail=200 api

ps:
	$(COMPOSE) ps

health:
	curl -fsS "http://127.0.0.1:$(PORT)/health" | python3 -m json.tool

shell:
	$(COMPOSE) exec api bash

backup:
	$(COMPOSE) exec -T api python scripts/backup.py --out /app/data/backups --keep 14

restore:
	@echo "用法：先解压备份到 ./data，再 make up"

admin:
	@echo "把目标邮箱加进 .env 的 FM_ADMIN_EMAILS 并重启即可获得运营后台权限"

lint:
	python3 -m ruff check .

test:
	cd backend && python3 -m pytest -q
