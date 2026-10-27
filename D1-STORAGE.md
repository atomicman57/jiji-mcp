# Persistent MCP storage

This deployment uses D1 (`MCP_STORAGE`) instead of Workers KV. Keep the existing Durable Object bindings and migrations. The adapter in `cloud/d1-kv.mjs` exposes the same get/put/delete/list interface required by the OAuth provider or cache; the OAUTH_KV/CHOWDECK_CACHE property is a JavaScript adapter, not a KV namespace.

Use the D1 database bound as `MCP_STORAGE` in your private deployment configuration. For an existing deployment, preserve that database, Durable Object bindings and secrets; do not recreate or replace populated storage during deployment. The repository configuration contains a placeholder database ID.

For a fresh independent deployment, create a D1 database, set its ID in `d1_databases`, and execute `cloud/d1-schema.sql` remotely before deploying. Expired records are rejected on reads immediately; scheduled cleanup removes them in bounded batches. Values are base64-encoded, not newly encrypted by this adapter, and have a 1.4 MB supported value limit. Existing application-level encryption remains in place.

The free D1 quotas still apply. No paid plan or billing change was made. Old KV namespaces are retained only as recovery copies; do not rebind them or redeploy a pre-migration config. Rolling back to KV would lose post-migration changes and can restore revoked credentials.
