@AGENTS.md

<!-- Add Claude Code-specific guidance here only when it has no AGENTS.md counterpart. -->

## Never spend money (user rule, 2026-10-06)

Never take an action that costs money or can start a charge. Free tiers only. If something would cost money, STOP and ask — explain what it costs and the free alternative.

- Never upgrade a plan, enable a paid add-on, buy a domain, or pick a paid tier — even a "small" or "pay-as-you-go" one.
- Never enter, add, or change a payment method. If a free signup asks for a card, the user does that step themselves.
- Never use a pay-per-use API key (e.g. an Anthropic API key) where a subscription or free option exists.
- Before any new cloud resource, confirm it is inside the free tier and will stay inside it.

Cloudflare (checked 2026-10-06; re-check before relying on it):
- **Zero Trust Free:** up to **50 users** at $0, Access included (500 applications). Pay-as-you-go is **$7/user/month** and charges for every user once you pass 50. Always choose **Free**; never add users toward 50.
- **Pages Free:** 500 deployments/month, 20,000 files and 25 MiB per file per site, 100 projects. Static requests are not charged. One upload per daily run is fine; never build a retry loop that could burn deployments.
- **Never enable** Workers Paid, R2/D1/KV past free quotas, Argo, Load Balancing, Images, Stream, or any feature marked as paid.
