"""
Google Business Profile Re-Authentication Script
Generates a refresh_token (with the business.manage scope) and saves it to a credentials file.

Usage:
  set GBP_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
  set GBP_OAUTH_CLIENT_SECRET=your-client-secret
  python gbp_reauth.py [output_path]

  Client ID/secret come from the OAuth 2.0 Client ID you created in Google Cloud Console
  (Desktop app type) — see README.md's Setup section. output_path defaults to
  gbp-credentials.json in this folder.
"""
import json
import os
import sys
from google_auth_oauthlib.flow import InstalledAppFlow

CLIENT_ID = os.environ.get("GBP_OAUTH_CLIENT_ID")
CLIENT_SECRET = os.environ.get("GBP_OAUTH_CLIENT_SECRET")

if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: set GBP_OAUTH_CLIENT_ID and GBP_OAUTH_CLIENT_SECRET environment variables first.")
    print("These come from your OAuth 2.0 Client ID's downloaded JSON (see README.md Setup section).")
    sys.exit(1)

CLIENT_CONFIG = {
    "installed": {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "auth_uri": "https://accounts.google.com/o/oauth2/auth",
        "token_uri": "https://oauth2.googleapis.com/token",
        "redirect_uris": ["http://localhost"],
    }
}

SCOPES = ["https://www.googleapis.com/auth/business.manage"]

OUTPUT_FILE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "gbp-credentials.json")

print("=" * 60)
print("Google Business Profile Re-Authentication")
print("=" * 60)
print("\nA browser window will open - log in with the Google account that")
print("owns/manages this Business Profile.\n")

flow = InstalledAppFlow.from_client_config(CLIENT_CONFIG, SCOPES)
credentials = flow.run_local_server(port=0, open_browser=True)

new_creds = {
    "client_id": credentials.client_id,
    "client_secret": credentials.client_secret,
    "refresh_token": credentials.refresh_token,
    "type": "authorized_user",
}

with open(OUTPUT_FILE, "w") as f:
    json.dump(new_creds, f, indent=2)

print("\n" + "=" * 60)
print("Authentication successful!")
print(f"Credentials saved to: {OUTPUT_FILE}")
print("=" * 60)
print("\nRestart your MCP client (e.g. Claude Code) so it picks up the new token.")
