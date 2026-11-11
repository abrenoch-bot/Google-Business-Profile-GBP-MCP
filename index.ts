#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OAuth2Client } from "google-auth-library";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

interface GbpCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: string;
}

function loadCredentials(): GbpCredentials {
  const credPath = process.env.GBP_CREDENTIALS_FILE
    ? path.resolve(process.env.GBP_CREDENTIALS_FILE)
    : path.resolve(__dirname, "gbp-credentials.json");

  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read GBP credentials file at "${credPath}". Set GBP_CREDENTIALS_FILE to a valid path, ` +
        `or create gbp-credentials.json in this folder (copy gbp-credentials.json.example and fill in real values). ` +
        `Original error: ${(err as Error).message}`
    );
  }

  let parsed: Partial<GbpCredentials>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GBP credentials file at "${credPath}" is not valid JSON: ${(err as Error).message}`);
  }

  const { client_id, client_secret, refresh_token } = parsed;
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error(
      `GBP credentials file at "${credPath}" is missing one or more required fields ` +
        `(client_id, client_secret, refresh_token). See gbp-credentials.json.example for the expected shape.`
    );
  }

  return {
    client_id,
    client_secret,
    refresh_token,
    type: parsed.type ?? "authorized_user",
  };
}

let credentials: GbpCredentials;
try {
  credentials = loadCredentials();
} catch (err) {
  process.stderr.write(`[gbp-mcp-server] Startup failed: ${(err as Error).message}\n`);
  process.exit(1);
}
const oauth2Client = new OAuth2Client(credentials.client_id, credentials.client_secret);
oauth2Client.setCredentials({ refresh_token: credentials.refresh_token });

async function getAccessToken(): Promise<string> {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) {
    throw new Error(
      "Failed to obtain an access token from the configured refresh_token. " +
        "Confirm the refresh token is valid and was minted with the https://www.googleapis.com/auth/business.manage scope."
    );
  }
  return token;
}

// ---------------------------------------------------------------------------
// REST plumbing
// ---------------------------------------------------------------------------

const BASE_URLS = {
  accountManagement: "https://mybusinessaccountmanagement.googleapis.com/v1",
  businessInformation: "https://mybusinessbusinessinformation.googleapis.com/v1",
  verifications: "https://mybusinessverifications.googleapis.com/v1",
  notifications: "https://mybusinessnotifications.googleapis.com/v1",
  placeActions: "https://mybusinessplaceactions.googleapis.com/v1",
  performance: "https://businessprofileperformance.googleapis.com/v1",
  legacyReviews: "https://mybusiness.googleapis.com/v4",
  // Posts have no replacement surface in the newer Business Profile APIs; the legacy
  // v4 localPosts endpoints (still documented/current) live on this host too.
  posts: "https://mybusiness.googleapis.com/v4",
} as const;

class GbpApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown
  ) {
    super(message);
    this.name = "GbpApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

async function gbpRequest(
  baseUrl: string,
  urlPath: string,
  opts: { method?: string; query?: Query; body?: unknown } = {}
): Promise<any> {
  const token = await getAccessToken();
  const url = new URL(baseUrl + urlPath);

  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let json: any = undefined;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!res.ok) {
    const message =
      json && typeof json === "object" && json.error?.message
        ? json.error.message
        : typeof json === "string" && json.length > 0
          ? json
          : `HTTP ${res.status} ${res.statusText}`;
    throw new GbpApiError(res.status, `Google API error (${res.status}): ${message}`, json);
  }

  return json ?? {};
}

/** Google returns `nextPageToken`; also surface it as `next_page_token` for consistency with our snake_case inputs. */
function withPaging(json: any) {
  if (json && typeof json === "object" && "nextPageToken" in json) {
    return { ...json, next_page_token: json.nextPageToken };
  }
  return json;
}

function ensurePrefix(id: string, prefix: string): string {
  return id.startsWith(`${prefix}/`) ? id : `${prefix}/${id}`;
}

// ---------------------------------------------------------------------------
// Shared zod fragments
// ---------------------------------------------------------------------------

const PageArgs = {
  page_size: z.number().int().positive().max(1000).optional().describe("Max results per page."),
  page_token: z.string().optional().describe("Token from a previous response's next_page_token, to fetch the next page."),
};

const DateShape = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});

const MonthShape = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
});

function dateQueryParams(prefix: string, date: z.infer<typeof DateShape>): Query {
  return {
    [`${prefix}.year`]: date.year,
    [`${prefix}.month`]: date.month,
    [`${prefix}.day`]: date.day,
  };
}

function monthQueryParams(prefix: string, month: z.infer<typeof MonthShape>): Query {
  return {
    [`${prefix}.year`]: month.year,
    [`${prefix}.month`]: month.month,
  };
}

// ---------------------------------------------------------------------------
// MCP server + tool registration helper
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "google-business-profile", version: "0.1.0" });

function toolResult(text: string, isError: boolean): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function registerTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>) => Promise<unknown>
) {
  const callback = async (args: any): Promise<CallToolResult> => {
    try {
      const data = await handler(args);
      return toolResult(JSON.stringify(data, null, 2), false);
    } catch (err) {
      if (err instanceof GbpApiError) {
        return toolResult(`${err.message}\n\nResponse body: ${JSON.stringify(err.body)}`, true);
      }
      const message = err instanceof Error ? err.message : String(err);
      return toolResult(message, true);
    }
  };
  server.registerTool(name, { description, inputSchema: shape }, callback as any);
}

// ===========================================================================
// My Business Account Management API v1
// ===========================================================================

registerTool(
  "list_accounts",
  "Lists the Google Business Profile accounts the authenticated user has access to.",
  {
    ...PageArgs,
    filter: z.string().optional().describe("Filter expression, e.g. type=USER_GROUP."),
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.accountManagement, "/accounts", {
        query: { pageSize: a.page_size, pageToken: a.page_token, filter: a.filter },
      })
    )
);

registerTool(
  "get_account",
  "Gets a single Google Business Profile account by name.",
  { account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123.") },
  async (a) => gbpRequest(BASE_URLS.accountManagement, `/${ensurePrefix(a.account_name, "accounts")}`)
);

registerTool(
  "list_account_admins",
  "Lists the admins (owners/managers) of a Business Profile account.",
  { account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123.") },
  async (a) => withPaging(await gbpRequest(BASE_URLS.accountManagement, `/${ensurePrefix(a.account_name, "accounts")}/admins`))
);

registerTool(
  "create_account_admin",
  "Invites/adds a new admin to a Business Profile account.",
  {
    account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123."),
    admin_email: z.string().describe("Email address of the user to invite as admin."),
    role: z
      .string()
      .describe('Admin role to grant, e.g. "OWNER", "MANAGER", or "COMMUNITY_MANAGER" (Google-defined AdminRole values).'),
  },
  async (a) =>
    gbpRequest(BASE_URLS.accountManagement, `/${ensurePrefix(a.account_name, "accounts")}/admins`, {
      method: "POST",
      body: { admin: a.admin_email, role: a.role },
    })
);

registerTool(
  "delete_account_admin",
  "Removes an admin from a Business Profile account.",
  {
    admin_name: z
      .string()
      .describe("Full admin resource name, e.g. accounts/123/admins/456 (from list_account_admins)."),
  },
  async (a) => gbpRequest(BASE_URLS.accountManagement, `/${a.admin_name}`, { method: "DELETE" })
);

registerTool(
  "list_location_admins",
  "Lists the admins of a specific location (used for locations shared independently of the parent account).",
  { location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123.") },
  async (a) => withPaging(await gbpRequest(BASE_URLS.accountManagement, `/${ensurePrefix(a.location_name, "locations")}/admins`))
);

registerTool(
  "create_location_admin",
  "Adds a new admin directly on a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    admin_email: z.string().describe("Email address of the user to invite as admin."),
    role: z.string().describe('Admin role to grant, e.g. "MANAGER" or "SITE_MANAGER".'),
  },
  async (a) =>
    gbpRequest(BASE_URLS.accountManagement, `/${ensurePrefix(a.location_name, "locations")}/admins`, {
      method: "POST",
      body: { admin: a.admin_email, role: a.role },
    })
);

registerTool(
  "delete_location_admin",
  "Removes an admin from a specific location.",
  { admin_name: z.string().describe("Full admin resource name, e.g. locations/123/admins/456.") },
  async (a) => gbpRequest(BASE_URLS.accountManagement, `/${a.admin_name}`, { method: "DELETE" })
);

// ===========================================================================
// My Business Business Information API v1
// ===========================================================================

registerTool(
  "list_locations",
  "Lists the locations under a Business Profile account. read_mask is required by the API " +
    '(comma-separated Location field paths, e.g. "name,title,storefrontAddress,phoneNumbers,websiteUri,metadata").',
  {
    account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123."),
    read_mask: z.string().describe("Comma-separated list of Location fields to return."),
    ...PageArgs,
    filter: z.string().optional(),
    order_by: z.string().optional(),
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.account_name, "accounts")}/locations`, {
        query: {
          readMask: a.read_mask,
          pageSize: a.page_size,
          pageToken: a.page_token,
          filter: a.filter,
          orderBy: a.order_by,
        },
      })
    )
);

registerTool(
  "get_location",
  "Gets a single location by name. read_mask is required by the API.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    read_mask: z.string().describe("Comma-separated list of Location fields to return."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}`, {
      query: { readMask: a.read_mask },
    })
);

registerTool(
  "create_location",
  "Creates a new location under an account. `body` is the raw Location resource JSON " +
    "(fields like title, categories, storefrontAddress, phoneNumbers, websiteUri, regularHours, etc. per Google's Location schema).",
  {
    account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123."),
    request_id: z.string().describe("Unique idempotency key for this create request."),
    validate_only: z.boolean().optional(),
    body: z.record(z.unknown()).describe("Raw Location resource fields to set on creation."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.account_name, "accounts")}/locations`, {
      method: "POST",
      query: { requestId: a.request_id, validateOnly: a.validate_only },
      body: a.body,
    })
);

registerTool(
  "update_location",
  "Updates fields on an existing location. `update_mask` and `body` must agree " +
    "(update_mask lists the Location field paths being changed; body carries their new values).",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    update_mask: z.string().describe("Comma-separated list of Location field paths to update."),
    validate_only: z.boolean().optional(),
    body: z.record(z.unknown()).describe("Raw Location resource fields being updated."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}`, {
      method: "PATCH",
      query: { updateMask: a.update_mask, validateOnly: a.validate_only },
      body: a.body,
    })
);

registerTool(
  "delete_location",
  "Deletes a location.",
  { location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123.") },
  async (a) => gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}`, { method: "DELETE" })
);

registerTool(
  "get_location_google_updated",
  "Gets the Google-maintained ('Google-updated') version of a location, which may differ from the owner-submitted version.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    read_mask: z.string().describe("Comma-separated list of Location fields to return."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}:getGoogleUpdated`, {
      query: { readMask: a.read_mask },
    })
);

registerTool(
  "get_location_attributes",
  "Looks up all attributes (e.g. wheelchair accessible, wifi, payment options) currently set for a location.",
  { location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123.") },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}/attributes`)
);

registerTool(
  "update_location_attributes",
  "Updates attribute values (e.g. wheelchair accessible, wifi) for a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    attribute_mask: z.string().describe("Comma-separated list of attribute names being updated."),
    attributes: z.array(z.record(z.unknown())).describe("Array of Attribute objects (each with a name and value(s))."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.location_name, "locations")}/attributes`, {
      method: "PATCH",
      query: { attributeMask: a.attribute_mask },
      body: { name: `${ensurePrefix(a.location_name, "locations")}/attributes`, attributes: a.attributes },
    })
);

registerTool(
  "list_location_categories",
  "Lists Google's business categories for a given language/region, optionally filtered by a display-name search term.",
  {
    region_code: z.string().describe('CLDR region code, e.g. "PK" or "US".'),
    language_code: z.string().describe('BCP-47 language code, e.g. "en".'),
    filter: z.string().optional().describe('Search filter, e.g. displayName=beauty*.'),
    view: z.enum(["BASIC", "FULL"]).optional(),
    ...PageArgs,
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.businessInformation, "/categories", {
        query: {
          regionCode: a.region_code,
          languageCode: a.language_code,
          filter: a.filter,
          view: a.view,
          pageSize: a.page_size,
          pageToken: a.page_token,
        },
      })
    )
);

registerTool(
  "batch_get_location_categories",
  "Resolves a set of category IDs (GConcept ids, e.g. gcid:beauty_salon) to display names for a given language.",
  {
    names: z.array(z.string()).describe('Category resource names/ids, e.g. ["gcid:beauty_salon"].'),
    language_code: z.string().describe('BCP-47 language code, e.g. "en".'),
    region_code: z.string().optional(),
    view: z.enum(["BASIC", "FULL"]).optional(),
  },
  async (a) =>
    gbpRequest(BASE_URLS.businessInformation, "/categories:batchGet", {
      query: { names: a.names, languageCode: a.language_code, regionCode: a.region_code, view: a.view },
    })
);

registerTool(
  "search_chains",
  "Searches Google's chain database by chain display name (for linking a location to a known retail/franchise chain).",
  {
    chain_display_name: z.string().describe("Chain name to search for."),
    ...PageArgs,
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.businessInformation, "/chains:search", {
        query: { chainName: a.chain_display_name, pageSize: a.page_size },
      })
    )
);

registerTool(
  "get_chain",
  "Gets details of a specific chain by resource name.",
  { chain_name: z.string().describe("Chain resource name or bare id, e.g. chains/123 or 123.") },
  async (a) => gbpRequest(BASE_URLS.businessInformation, `/${ensurePrefix(a.chain_name, "chains")}`)
);

// ===========================================================================
// My Business Verifications API v1
// ===========================================================================

registerTool(
  "fetch_verification_options",
  "Fetches the verification methods (ADDRESS, EMAIL, PHONE_CALL, SMS, VETTED_PARTNER, etc.) currently available for a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    language_code: z.string().optional(),
  },
  async (a) =>
    gbpRequest(BASE_URLS.verifications, `/${ensurePrefix(a.location_name, "locations")}:fetchVerificationOptions`, {
      method: "POST",
      body: { languageCode: a.language_code },
    })
);

registerTool(
  "create_verification",
  "Starts (initiates) a verification for a location using one of the methods returned by fetch_verification_options.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    method: z.enum(["ADDRESS", "EMAIL", "PHONE_CALL", "SMS", "VETTED_PARTNER", "AUTO"]).describe("Verification method to use."),
    language_code: z.string().optional(),
    body: z
      .record(z.unknown())
      .optional()
      .describe("Extra method-specific fields (e.g. mailerContact for ADDRESS, emailAddress for EMAIL)."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.verifications, `/${ensurePrefix(a.location_name, "locations")}:verify`, {
      method: "POST",
      body: { method: a.method, languageCode: a.language_code, ...(a.body ?? {}) },
    })
);

registerTool(
  "complete_verification",
  "Completes a pending verification (e.g. submitting the PIN code received via postcard/SMS/phone).",
  {
    verification_name: z.string().describe("Verification resource name, e.g. locations/123/verifications/456."),
    pin: z.string().describe("The PIN/code the merchant received."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.verifications, `/${a.verification_name}:complete`, {
      method: "POST",
      body: { pin: a.pin },
    })
);

registerTool(
  "list_verifications",
  "Lists past and pending verifications for a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    ...PageArgs,
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.verifications, `/${ensurePrefix(a.location_name, "locations")}/verifications`, {
        query: { pageSize: a.page_size, pageToken: a.page_token },
      })
    )
);

registerTool(
  "get_voice_of_merchant_state",
  "Gets whether a location is eligible to have its Business Profile actively appear on Google (Voice of Merchant state).",
  { location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123.") },
  async (a) =>
    gbpRequest(BASE_URLS.verifications, `/${ensurePrefix(a.location_name, "locations")}/VoiceOfMerchantState`)
);

// ===========================================================================
// My Business Notifications API v1
// ===========================================================================

registerTool(
  "get_notification_settings",
  "Gets the Pub/Sub notification configuration for an account (which topic Google publishes update/review notifications to).",
  { account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123.") },
  async (a) =>
    gbpRequest(BASE_URLS.notifications, `/${ensurePrefix(a.account_name, "accounts")}/notificationSetting`)
);

registerTool(
  "update_notification_settings",
  "Sets the Pub/Sub topic and notification types an account should receive (Q&A notification types are no longer valid " +
    "since the My Business Q&A API was discontinued on 2025-11-03).",
  {
    account_name: z.string().describe("Account resource name or bare id, e.g. accounts/123 or 123."),
    pubsub_topic: z.string().describe('Full Pub/Sub topic name, e.g. "projects/my-project/topics/my-topic".'),
    notification_types: z
      .array(z.string())
      .describe(
        'Notification types to subscribe to, e.g. ["GOOGLE_UPDATE","NEW_REVIEW","UPDATED_REVIEW","NEW_CUSTOMER_MEDIA"].'
      ),
  },
  async (a) => {
    const name = `${ensurePrefix(a.account_name, "accounts")}/notificationSetting`;
    return gbpRequest(BASE_URLS.notifications, `/${name}`, {
      method: "PATCH",
      query: { updateMask: "pubsubTopic,notificationTypes" },
      body: { name, pubsubTopic: a.pubsub_topic, notificationTypes: a.notification_types },
    });
  }
);

// ===========================================================================
// My Business Place Actions API v1
// ===========================================================================

registerTool(
  "list_place_action_links",
  "Lists place action links (e.g. 'Order food', 'Book appointment' deep links) configured on a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    filter: z.string().optional(),
    ...PageArgs,
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.placeActions, `/${ensurePrefix(a.location_name, "locations")}/placeActionLinks`, {
        query: { filter: a.filter, pageSize: a.page_size, pageToken: a.page_token },
      })
    )
);

registerTool(
  "get_place_action_link",
  "Gets a single place action link by resource name.",
  { name: z.string().describe("Full place action link resource name, e.g. locations/123/placeActionLinks/456.") },
  async (a) => gbpRequest(BASE_URLS.placeActions, `/${a.name}`)
);

registerTool(
  "create_place_action_link",
  "Creates a new place action link on a location. Call list_place_action_types first to see valid placeActionType values.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    uri: z.string().describe("Destination URL for the action (e.g. your online ordering/booking page)."),
    place_action_type: z.string().describe('Place action type, e.g. "ORDER_ONLINE" or "APPOINTMENT" (see list_place_action_types).'),
    is_preferred: z.boolean().optional(),
    extra: z.record(z.unknown()).optional().describe("Any additional PlaceActionLink fields (e.g. providerType)."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.placeActions, `/${ensurePrefix(a.location_name, "locations")}/placeActionLinks`, {
      method: "POST",
      body: {
        uri: a.uri,
        placeActionType: a.place_action_type,
        isPreferred: a.is_preferred,
        ...(a.extra ?? {}),
      },
    })
);

registerTool(
  "update_place_action_link",
  "Updates an existing place action link.",
  {
    name: z.string().describe("Full place action link resource name, e.g. locations/123/placeActionLinks/456."),
    update_mask: z.string().describe("Comma-separated list of PlaceActionLink field paths to update."),
    body: z.record(z.unknown()).describe("New field values for the fields listed in update_mask."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.placeActions, `/${a.name}`, {
      method: "PATCH",
      query: { updateMask: a.update_mask },
      body: { name: a.name, ...a.body },
    })
);

registerTool(
  "delete_place_action_link",
  "Deletes a place action link.",
  { name: z.string().describe("Full place action link resource name, e.g. locations/123/placeActionLinks/456.") },
  async (a) => gbpRequest(BASE_URLS.placeActions, `/${a.name}`, { method: "DELETE" })
);

registerTool(
  "list_place_action_types",
  "Lists the place action types Google currently supports (e.g. ORDER_ONLINE, APPOINTMENT, BUY, LEARN_MORE) and their metadata.",
  { ...PageArgs, language_code: z.string().optional() },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.placeActions, "/placeActionTypeMetadata", {
        query: { pageSize: a.page_size, pageToken: a.page_token, languageCode: a.language_code },
      })
    )
);

// ===========================================================================
// Reviews — legacy v4 mybusiness.googleapis.com
// (Confirmed still active/supported for review read+reply in 2026, even though most other
//  v4 endpoints were retired in April 2022; there is no newer replacement surface for reviews.)
// ===========================================================================

registerTool(
  "list_reviews",
  "Lists reviews for a location (legacy v4 Reviews API — still the current supported surface for reviews).",
  {
    account_id: z.string().describe("Numeric account id (without the accounts/ prefix)."),
    location_id: z.string().describe("Numeric location id (without the locations/ prefix)."),
    ...PageArgs,
    order_by: z.string().optional().describe('e.g. "updateTime desc" or "rating desc".'),
  },
  async (a) =>
    withPaging(
      await gbpRequest(BASE_URLS.legacyReviews, `/accounts/${a.account_id}/locations/${a.location_id}/reviews`, {
        query: { pageSize: a.page_size, pageToken: a.page_token, orderBy: a.order_by },
      })
    )
);

registerTool(
  "get_review",
  "Gets a single review by id.",
  {
    account_id: z.string().describe("Numeric account id."),
    location_id: z.string().describe("Numeric location id."),
    review_id: z.string().describe("Review id."),
  },
  async (a) =>
    gbpRequest(BASE_URLS.legacyReviews, `/accounts/${a.account_id}/locations/${a.location_id}/reviews/${a.review_id}`)
);

registerTool(
  "reply_to_review",
  "Creates or replaces the business's reply to a review.",
  {
    account_id: z.string().describe("Numeric account id."),
    location_id: z.string().describe("Numeric location id."),
    review_id: z.string().describe("Review id."),
    comment: z.string().describe("Reply text."),
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.legacyReviews,
      `/accounts/${a.account_id}/locations/${a.location_id}/reviews/${a.review_id}:updateReply`,
      { method: "PATCH", body: { comment: a.comment } }
    )
);

registerTool(
  "delete_review_reply",
  "Deletes the business's reply to a review.",
  {
    account_id: z.string().describe("Numeric account id."),
    location_id: z.string().describe("Numeric location id."),
    review_id: z.string().describe("Review id."),
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.legacyReviews,
      `/accounts/${a.account_id}/locations/${a.location_id}/reviews/${a.review_id}:deleteReply`,
      { method: "DELETE" }
    )
);

// ===========================================================================
// Business Profile Performance API v1
// ===========================================================================

const DailyMetricEnum = z.enum([
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
  "BUSINESS_BOOKINGS",
  "BUSINESS_FOOD_ORDERS",
  "BUSINESS_FOOD_MENU_CLICKS",
]);

registerTool(
  "get_daily_metrics",
  "Gets a time series for a single daily performance metric (e.g. WEBSITE_CLICKS, CALL_CLICKS) for a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    daily_metric: DailyMetricEnum,
    start_date: DateShape,
    end_date: DateShape,
  },
  async (a) =>
    gbpRequest(BASE_URLS.performance, `/${ensurePrefix(a.location_name, "locations")}:getDailyMetricsTimeSeries`, {
      query: {
        dailyMetric: a.daily_metric,
        ...dateQueryParams("daily_range.start_date", a.start_date),
        ...dateQueryParams("daily_range.end_date", a.end_date),
      },
    })
);

registerTool(
  "get_multi_daily_metrics",
  "Gets time series for multiple daily performance metrics at once for a location.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    daily_metrics: z.array(DailyMetricEnum).min(1),
    start_date: DateShape,
    end_date: DateShape,
  },
  async (a) =>
    gbpRequest(BASE_URLS.performance, `/${ensurePrefix(a.location_name, "locations")}:fetchMultiDailyMetricsTimeSeries`, {
      query: {
        dailyMetrics: a.daily_metrics,
        ...dateQueryParams("daily_range.start_date", a.start_date),
        ...dateQueryParams("daily_range.end_date", a.end_date),
      },
    })
);

registerTool(
  "search_keyword_impressions",
  "Lists the search keywords used to find a location on Search/Maps, with monthly impression counts.",
  {
    location_name: z.string().describe("Location resource name or bare id, e.g. locations/123 or 123."),
    start_month: MonthShape,
    end_month: MonthShape,
    ...PageArgs,
  },
  async (a) =>
    withPaging(
      await gbpRequest(
        BASE_URLS.performance,
        `/${ensurePrefix(a.location_name, "locations")}/searchkeywords/impressions/monthly`,
        {
          query: {
            ...monthQueryParams("monthly_range.start_month", a.start_month),
            ...monthQueryParams("monthly_range.end_month", a.end_month),
            pageSize: a.page_size,
            pageToken: a.page_token,
          },
        }
      )
    )
);

// ===========================================================================
// Local Posts — legacy v4 mybusiness.googleapis.com/v4
// (Excluded from the upstream build as a scope decision; re-added here because Posts
//  are the one GBP capability with no newer API surface.)
// ===========================================================================

const LocalPostCtaType = z.enum(["BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);
const LocalPostTopicType = z.enum(["STANDARD", "EVENT", "OFFER"]);

function buildLocalPost(a: {
  summary?: string;
  language_code?: string;
  cta_type?: z.infer<typeof LocalPostCtaType>;
  cta_url?: string;
  photo_url?: string;
  topic_type?: z.infer<typeof LocalPostTopicType>;
  event?: unknown;
  offer?: unknown;
}): Record<string, unknown> {
  const post: Record<string, unknown> = {};
  if (a.language_code !== undefined) post.languageCode = a.language_code;
  if (a.summary !== undefined) post.summary = a.summary;
  if (a.topic_type !== undefined) post.topicType = a.topic_type;
  if (a.cta_type !== undefined) {
    post.callToAction =
      a.cta_type === "CALL" ? { actionType: "CALL" } : { actionType: a.cta_type, url: a.cta_url };
  }
  if (a.photo_url !== undefined) post.media = [{ mediaFormat: "PHOTO", sourceUrl: a.photo_url }];
  if (a.event !== undefined) post.event = a.event;
  if (a.offer !== undefined) post.offer = a.offer;
  return post;
}

const PostLocationArgs = {
  account_id: z.string().describe("Numeric account id (without the accounts/ prefix)."),
  location_id: z.string().describe("Numeric location id (without the locations/ prefix)."),
};

const PostBodyArgs = {
  summary: z.string().max(1500).optional().describe("Post text (max 1500 chars)."),
  language_code: z.string().optional().describe('BCP-47 language code, e.g. "en".'),
  cta_type: LocalPostCtaType.optional().describe("Call-to-action button type. CALL uses the listing's phone (no url)."),
  cta_url: z.string().url().optional().describe("Required for every cta_type except CALL."),
  photo_url: z
    .string()
    .url()
    .optional()
    .describe("Publicly reachable JPG/PNG URL (>=250x250 px, >=10 KB)."),
  topic_type: LocalPostTopicType.optional().describe('Defaults to STANDARD when omitted.'),
  event: z.unknown().optional().describe("Raw Google Event JSON (topicType EVENT)."),
  offer: z.unknown().optional().describe("Raw Google Offer JSON (topicType OFFER)."),
};

registerTool(
  "create_local_post",
  "Publishes a post (What's New / EVENT / OFFER) on a location via the legacy v4 localPosts API. summary is required by Google; optionally add a CTA button, a public photo URL, and event/offer details.",
  {
    ...PostLocationArgs,
    ...PostBodyArgs,
    summary: z.string().max(1500).describe("Post text (max 1500 chars)."),
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.posts,
      `/accounts/${a.account_id}/locations/${a.location_id}/localPosts`,
      { method: "POST", body: buildLocalPost({ ...a, language_code: a.language_code ?? "en" }) }
    )
);

registerTool(
  "list_local_posts",
  "Lists posts for a location.",
  { ...PostLocationArgs, ...PageArgs },
  async (a) =>
    withPaging(
      await gbpRequest(
        BASE_URLS.posts,
        `/accounts/${a.account_id}/locations/${a.location_id}/localPosts`,
        { query: { pageSize: a.page_size, pageToken: a.page_token } }
      )
    )
);

registerTool(
  "get_local_post",
  "Gets a single post by id.",
  {
    ...PostLocationArgs,
    post_id: z.string().describe("Post id (trailing id of the localPosts resource name)."),
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.posts,
      `/accounts/${a.account_id}/locations/${a.location_id}/localPosts/${a.post_id}`
    )
);

registerTool(
  "update_local_post",
  'Updates fields on an existing post. Only fields named in update_mask are changed, e.g. "summary" or "summary,callToAction".',
  {
    ...PostLocationArgs,
    post_id: z.string().describe("Post id (trailing id of the localPosts resource name)."),
    update_mask: z.string().describe('Comma-separated field paths to update, e.g. "summary,callToAction".'),
    ...PostBodyArgs,
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.posts,
      `/accounts/${a.account_id}/locations/${a.location_id}/localPosts/${a.post_id}`,
      { method: "PATCH", query: { updateMask: a.update_mask }, body: buildLocalPost(a) }
    )
);

registerTool(
  "delete_local_post",
  "Deletes a post.",
  {
    ...PostLocationArgs,
    post_id: z.string().describe("Post id (trailing id of the localPosts resource name)."),
  },
  async (a) =>
    gbpRequest(
      BASE_URLS.posts,
      `/accounts/${a.account_id}/locations/${a.location_id}/localPosts/${a.post_id}`,
      { method: "DELETE" }
    )
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
