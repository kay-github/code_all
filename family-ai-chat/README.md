# Family AI Chat

This folder runs NextChat behind Cloudflare Tunnel.

## Fill secrets

Copy `env.template` to `.env`, then fill in your values before starting:

- `OPENAI_API_KEY`: your model provider API key.
- `CHAT_ACCESS_CODE`: the password family members enter in the web UI.
- `CLOUDFLARE_TUNNEL_TOKEN`: token copied from Cloudflare Zero Trust Tunnel setup.

## Start

```powershell
docker compose pull
docker compose up -d
```

Local test URL:

```text
http://localhost:3000
```

Cloudflare Public Hostname service URL:

```text
http://chatgpt-next-web:3000
```
