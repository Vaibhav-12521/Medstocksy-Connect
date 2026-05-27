/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  readonly VITE_INVENTORY_APP_URL?: string;
  readonly VITE_SENTRY_DSN?: string;
  /** Optional URL of the wa-bot sibling service (e.g. http://localhost:3001).
   *  When set together with VITE_WA_BOT_SECRET, sends route through openWA. */
  readonly VITE_WA_BOT_URL?: string;
  readonly VITE_WA_BOT_SECRET?: string;
  /** Set to 'true' only after enabling the Google provider in Supabase →
   *  Auth → Providers. Hides the "Continue with Google" button otherwise. */
  readonly VITE_ENABLE_GOOGLE_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;
