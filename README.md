# Google Business Profile (GBP) MCP Server

An open-source [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
Google Business Profile management as tools for AI agents (Claude, or any MCP-compatible client).
40 tools covering accounts, locations, verifications, notifications, place action links, reviews,
and performance analytics — built directly against Google's REST APIs (not the outdated
`googleapis` npm package's GBP coverage).

## Features

- List/manage Business Profile accounts and their admins
- Create, read, update, delete locations and their attributes
- Handle location verification (start, complete, check status)
- Configure Pub/Sub notification settings
- Manage place action links (order online, book appointment, etc.)
- List reviews, reply to reviews, delete replies
- Pull daily performance metrics (impressions, calls, clicks, direction requests, bookings) and
  search-keyword impression data

**Explicitly out of scope:** Q&A management (Google discontinued the My Business Q&A API on
2025-11-03 — there is no way to implement this even if desired) and Posts (`localPosts`) — not
confirmed deprecated, but intentionally excluded from this build; see [Notes](#notes) for the
full detail so this isn't misread as a confirmed API shutdown.

## Prerequisites

- Node.js 18+
- A Google Cloud project
- **Approved access to the Business Profile APIs.** Enabling these APIs in Cloud Console is not
  enough — Google gates the whole "My Business" API family behind a separate access-request
  approval. Until it's approved, every call fails with a `429 RESOURCE_EXHAUSTED` /
  `quota_limit_value: "0"` error (this looks like a rate limit but is actually an access gate).
  Search "Google Business Profile API access request form" and submit it for your project —
  approval historically favors agencies/platforms managing multiple locations over single-business
  owners, and can take anywhere from a few days to a couple of weeks.
- (Optional, only needed for `gbp_reauth.py`) Python 3 with `google-auth-oauthlib` installed
  (`pip install google-auth-oauthlib`)

## Setup

### 1. Enable the required APIs

In [Google Cloud Console → APIs & Services → Library](https://console.cloud.google.com/apis/library),
search for and **Enable** each of the following (all under the "My Business" / "Business Profile"
family):

| # | API name to search | Used for |
|---|---|---|
| 1 | **My Business Account Management API** | Accounts, account admins, location admins |
| 2 | **My Business Business Information API** | Locations, location attributes, categories, chains |
| 3 | **My Business Verifications API** | Location verification flow |
| 4 | **My Business Notifications API** | Pub/Sub update/review notification settings |
| 5 | **My Business Place Actions API** | Place action links (order online, book, etc.) |
| 6 | **Business Profile Performance API** | Daily metrics, search-keyword impressions |
| 7 | **My Business API** (legacy v4) | Reviews (list/get/reply/delete-reply) — this is the only
      surface Google still supports for reviews; there is no newer replacement |

### 2. Request Business Profile API access

Enabling the APIs above does **not** grant you quota — submit Google's separate Business Profile
API access-request form for the same Cloud project (see Prerequisites above). Wait for approval
before continuing; every tool call will fail with a quota-zero error until then.

### 3. Create an OAuth 2.0 Client ID

In Cloud Console → APIs & Services → Credentials → Create Credentials → OAuth client ID →
**Desktop app**. Download the resulting JSON — you'll need its `client_id` and `client_secret`.

### 4. Mint a refresh token

```bash
pip install google-auth-oauthlib
set GBP_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
set GBP_OAUTH_CLIENT_SECRET=your-client-secret
python gbp_reauth.py
```

This opens a browser consent screen requesting the `https://www.googleapis.com/auth/business.manage`
scope, then writes `gbp-credentials.json` in this folder (pass a path as the first argument to
save elsewhere). Log in with the Google account that owns/manages the target Business Profile(s).

You can also do this by hand: copy `gbp-credentials.json.example` to `gbp-credentials.json` and
fill in `client_id` / `client_secret` / `refresh_token` yourself if you already have a token minted
elsewhere with the `business.manage` scope.

### 5. Install and run

```bash
npm install
npx tsx index.ts
```

Set `GBP_CREDENTIALS_FILE` to point at a credentials file in a different location; it defaults to
`./gbp-credentials.json` relative to this folder.

### 6. Wire it into an MCP client

Example for Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "google-business-profile": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/gbp-mcp-server/index.ts"],
      "env": {
        "GBP_CREDENTIALS_FILE": "/absolute/path/to/gbp-credentials.json"
      }
    }
  }
}
```

## Tool reference (40 tools)

### Account Management (`mybusinessaccountmanagement.googleapis.com`)

| Tool | What it does |
|---|---|
| `list_accounts` | Lists the Business Profile accounts the authenticated user has access to |
| `get_account` | Gets a single account by name |
| `list_account_admins` | Lists the admins (owners/managers) of an account |
| `create_account_admin` | Invites/adds a new admin to an account |
| `delete_account_admin` | Removes an admin from an account |
| `list_location_admins` | Lists the admins of a specific location |
| `create_location_admin` | Adds a new admin directly on a location |
| `delete_location_admin` | Removes an admin from a specific location |

### Business Information (`mybusinessbusinessinformation.googleapis.com`)

| Tool | What it does |
|---|---|
| `list_locations` | Lists the locations under an account (requires `read_mask`) |
| `get_location` | Gets a single location by name (requires `read_mask`) |
| `create_location` | Creates a new location under an account |
| `update_location` | Updates fields on an existing location (requires matching `update_mask`) |
| `delete_location` | Deletes a location |
| `get_location_google_updated` | Gets the Google-maintained version of a location, which can differ from what the owner submitted |
| `get_location_attributes` | Looks up all attributes (wifi, wheelchair accessible, payment options, etc.) currently set on a location |
| `update_location_attributes` | Updates attribute values for a location (requires matching `attribute_mask`) |
| `list_location_categories` | Lists Google's business categories for a language/region, optionally filtered by search term |
| `batch_get_location_categories` | Resolves category IDs to display names |
| `search_chains` | Searches Google's chain database by display name |
| `get_chain` | Gets details of a specific chain |

### Verifications (`mybusinessverifications.googleapis.com`)

| Tool | What it does |
|---|---|
| `fetch_verification_options` | Fetches the verification methods (ADDRESS, EMAIL, PHONE_CALL, SMS, VETTED_PARTNER) currently available for a location |
| `create_verification` | Starts a verification using one of the fetched methods |
| `complete_verification` | Completes a pending verification by submitting the received PIN |
| `list_verifications` | Lists past and pending verifications for a location |
| `get_voice_of_merchant_state` | Checks whether a location is eligible to actively appear on Google |

### Notifications (`mybusinessnotifications.googleapis.com`)

| Tool | What it does |
|---|---|
| `get_notification_settings` | Gets the Pub/Sub topic and notification types configured for an account |
| `update_notification_settings` | Sets the Pub/Sub topic and notification types an account should receive |

### Place Actions (`mybusinessplaceactions.googleapis.com`)

| Tool | What it does |
|---|---|
| `list_place_action_links` | Lists place action links (order online, book appointment, etc.) on a location |
| `get_place_action_link` | Gets a single place action link by name |
| `create_place_action_link` | Creates a new place action link |
| `update_place_action_link` | Updates an existing place action link (requires matching `update_mask`) |
| `delete_place_action_link` | Deletes a place action link |
| `list_place_action_types` | Lists the place action types Google currently supports |

### Reviews — legacy v4 (`mybusiness.googleapis.com/v4`)

| Tool | What it does |
|---|---|
| `list_reviews` | Lists reviews for a location |
| `get_review` | Gets a single review by ID |
| `reply_to_review` | Creates or replaces the business's reply to a review |
| `delete_review_reply` | Deletes the business's reply to a review |

### Performance (`businessprofileperformance.googleapis.com`)

| Tool | What it does |
|---|---|
| `get_daily_metrics` | Gets a time series for a single daily metric (e.g. `WEBSITE_CLICKS`, `CALL_CLICKS`, `BUSINESS_IMPRESSIONS_DESKTOP_SEARCH`) |
| `get_multi_daily_metrics` | Gets time series for multiple daily metrics at once |
| `search_keyword_impressions` | Lists the search keywords used to find a location, with monthly impression counts |

## Notes

- `list_locations` / `get_location` / `get_location_google_updated` require a `read_mask` —
  Google's API rejects requests without one (a comma-separated list of `Location` field paths).
- `update_location`, `update_location_attributes`, and `update_place_action_link` require a matching
  `update_mask` / `attribute_mask` field-path list alongside the new values.
- `create_location`, `update_location`, `create_place_action_link`, `update_place_action_link`, and
  `update_location_attributes` accept raw Google resource JSON via a `body` / `attributes` / `extra`
  field rather than a fully-typed schema — the underlying `Location` and `PlaceActionLink` resources
  have large, evolving field sets, and passing raw JSON through avoids re-modeling (and potentially
  mis-modeling) Google's schema in TypeScript.
- **Q&A** is confirmed discontinued as of 2025-11-03 (Google's own change log). Excluded entirely.
- **Posts** (`localPosts`) is *not* confirmed deprecated — Google's docs show it active with recent
  feature additions. It's excluded from this build as a deliberate scope decision, not because the
  API was shut down — don't cite this repo as evidence that Posts access no longer works.
- **Lodging API** (`mybusinesslodging.googleapis.com`) is out of scope — hotel/lodging-only
  attributes, not relevant here.
- Every tool calls Google's REST endpoints directly via `fetch` and surfaces Google's own
  `error.message` on any non-2xx response rather than swallowing it.

## License

MIT — see [LICENSE](LICENSE).
