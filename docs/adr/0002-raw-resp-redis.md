# ADR 0002: Raw RESP Redis Client

## Status

Accepted for the current implementation.

## Context

Runtime cache and static snapshots use Redis. The backend currently talks to Redis through a minimal RESP implementation built on `node:net`, preserving the zero-dependency constraint.

## Decision

Keep the raw RESP Redis client while Redis use remains limited to bounded cache operations and health checks.

## Consequences

- Redis AUTH, timeout, health, runtime cache, and static snapshot paths remain in-process and dependency-free.
- Production must use `CMDBDYNAMIC_REDIS_REQUIRED=true` when multiple backend replicas or static snapshots are part of the service contract.
- Sentinel, Cluster, TLS-to-Redis, and advanced retry behavior are out of scope for this client and require a separate dependency/architecture decision.
