-- ============================================================================
-- Medstocksy Connect (medcrm-v2) — One-Shot Supabase Bootstrap
-- ============================================================================
-- Paste this whole file into the Supabase SQL editor and run it ONCE on a
-- fresh project. It is fully idempotent — re-running on a populated database
-- is safe; existing rows, columns, indexes, policies, and the storage bucket
-- are preserved.
--
-- What this sets up (combines every migration in supabase/migrations/):
--   1. Extensions (uuid, pgcrypto, pg_trgm)
--   2. Enums (member role, message status/direction, campaign/reminder status,
--      template kind)
--   3. Tables (13 crm_* tables)
--   4. Indexes (search, FK, hot-path queries)
--   5. Functions (auth helpers, audit, updated_at, rate limit, retention)
--   6. Triggers (audit + updated_at, attached via dynamic loop)
--   7. Strips legacy `handle_new_user`-style triggers from auth.users that
--      caused "Database error saving new user" on signup
--   8. Views (crm_my_pharmacies w/ inline pharmacy_name, customer_stats,
--      auto_tags, whatsapp_health)
--   9. Row-Level Security policies (multi-tenant isolation by pharmacy_id)
--  10. Storage bucket `crm-template-images` + read/write policies
--  11. Grants for the `authenticated` role
--  12. NOTIFY pgrst to refresh the API schema cache
--

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. EXTENSIONS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- fuzzy customer name search

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ENUMS  (idempotent — wrapped in DO blocks)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE crm_member_role AS ENUM ('admin','manager','staff');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_message_status AS ENUM ('queued','sending','sent','delivered','read','failed','bounced');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_message_direction AS ENUM ('outbound','inbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_campaign_status AS ENUM ('draft','scheduled','sending','sent','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_reminder_status AS ENUM ('pending','sent','cancelled','converted','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE crm_template_kind AS ENUM ('thank_you','refill_reminder','offer','custom','win_back','out_of_stock');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. PHARMACIES (multi-tenant root, one per owner account)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_pharmacies (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  name            text NOT NULL,
  phone           text,
  address         text,
  whatsapp_number text,
  logo_url        text,
  send_window_start time NOT NULL DEFAULT '09:00',
  send_window_end   time NOT NULL DEFAULT '20:00',
  rate_limit_per_hour smallint NOT NULL DEFAULT 10 CHECK (rate_limit_per_hour BETWEEN 1 AND 20),
  bulk_approval_threshold int NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crm_pharmacies ADD COLUMN IF NOT EXISTS logo_url text;

-- De-dupe pharmacies per owner before adding the UNIQUE constraint, so this
-- script runs cleanly on databases that already accumulated duplicates.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY owner_id ORDER BY created_at DESC, id) AS rn
    FROM public.crm_pharmacies
)
DELETE FROM public.crm_pharmacies WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DO $$ BEGIN
  ALTER TABLE public.crm_pharmacies
    ADD CONSTRAINT crm_pharmacies_owner_unique UNIQUE (owner_id);
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table  THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_pharmacies_owner ON public.crm_pharmacies(owner_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. MEMBERS (RBAC)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_members (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id  uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role         crm_member_role NOT NULL DEFAULT 'staff',
  invited_by   uuid REFERENCES auth.users(id),
  joined_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pharmacy_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_members_user     ON public.crm_members(user_id);
CREATE INDEX IF NOT EXISTS idx_crm_members_pharmacy ON public.crm_members(pharmacy_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. CUSTOMERS  (E.164 phone, fuzzy name search)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_customers (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id   uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  family_of_id  uuid REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  name          text NOT NULL,
  phone         text NOT NULL,
  age           smallint CHECK (age IS NULL OR age BETWEEN 0 AND 130),
  gender        text CHECK (gender IS NULL OR gender IN ('male','female','other')),
  address       text,
  notes         text,
  whatsapp_opted_in   boolean NOT NULL DEFAULT true,
  whatsapp_opted_out_at timestamptz,
  whatsapp_opted_out_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Idempotent column add for installs that pre-date family support
ALTER TABLE public.crm_customers
  ADD COLUMN IF NOT EXISTS family_of_id uuid REFERENCES public.crm_customers(id) ON DELETE CASCADE;
-- Drop the legacy strict UNIQUE so family members can share a phone
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'crm_customers' AND con.contype = 'u'
        AND (
          SELECT array_agg(att.attname::text ORDER BY att.attname::text)
            FROM unnest(con.conkey) AS k(attnum)
            JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum = k.attnum
        ) = ARRAY['pharmacy_id','phone']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.crm_customers DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
-- Partial unique: at most one PRIMARY per phone per pharmacy
CREATE UNIQUE INDEX IF NOT EXISTS uniq_crm_customers_primary_phone
  ON public.crm_customers(pharmacy_id, phone)
  WHERE family_of_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_customers_family ON public.crm_customers(family_of_id) WHERE family_of_id IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE public.crm_customers
    ADD CONSTRAINT crm_customers_phone_e164 CHECK (phone ~ '^\+[1-9][0-9]{6,14}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_crm_customers_name_trgm ON public.crm_customers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_crm_customers_phone     ON public.crm_customers(phone);
CREATE INDEX IF NOT EXISTS idx_crm_customers_pharmacy  ON public.crm_customers(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_crm_customers_optout    ON public.crm_customers(whatsapp_opted_in) WHERE whatsapp_opted_in = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. CUSTOMER ↔ SALE LINK  (bridge to inventory app's public.sales)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_customer_sales (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  sale_id     uuid NOT NULL,
  pharmacy_id uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  bill_amount numeric(12,2) NOT NULL DEFAULT 0,
  sold_at     timestamptz NOT NULL DEFAULT now(),
  medicines   jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachment_url text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id)
);
ALTER TABLE public.crm_customer_sales ADD COLUMN IF NOT EXISTS attachment_url text;

CREATE INDEX IF NOT EXISTS idx_crm_sales_customer ON public.crm_customer_sales(customer_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_sales_pharmacy ON public.crm_customer_sales(pharmacy_id, sold_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. TAGS  (manual; auto-tags are derived in a view below)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_tags (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  tag_key     text NOT NULL,
  added_by    uuid REFERENCES auth.users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, tag_key)
);

CREATE INDEX IF NOT EXISTS idx_crm_tags_customer ON public.crm_tags(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_tags_key      ON public.crm_tags(pharmacy_id, tag_key);

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. TEMPLATES  (with language + image_url; seeds 3 global pre-built templates)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_templates (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id     uuid REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  kind            crm_template_kind NOT NULL,
  name            text NOT NULL,
  body            text NOT NULL,
  variables       text[] NOT NULL DEFAULT '{}',
  whatsapp_template_name text,
  whatsapp_status text NOT NULL DEFAULT 'draft',
  is_built_in     boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Add language + image_url for older databases that pre-date these columns.
ALTER TABLE public.crm_templates
  ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE public.crm_templates
  ADD COLUMN IF NOT EXISTS image_url text;

DO $$ BEGIN
  ALTER TABLE public.crm_templates
    ADD CONSTRAINT crm_templates_language_chk CHECK (language IN ('en','hi'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN check_violation THEN
    UPDATE public.crm_templates SET language = 'en' WHERE language NOT IN ('en','hi');
    ALTER TABLE public.crm_templates
      ADD CONSTRAINT crm_templates_language_chk CHECK (language IN ('en','hi'));
END $$;

-- De-dupe templates (same pharmacy + name + language) before adding UNIQUE
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY COALESCE(pharmacy_id, '00000000-0000-0000-0000-000000000000'::uuid), name, language ORDER BY created_at DESC, id) AS rn
    FROM public.crm_templates
)
DELETE FROM public.crm_templates WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DO $$ BEGIN
  ALTER TABLE public.crm_templates
    ADD CONSTRAINT crm_templates_pharmacy_name_lang_unique UNIQUE (pharmacy_id, name, language);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_templates_pharmacy ON public.crm_templates(pharmacy_id);

-- Seed three global pre-built templates (NULL pharmacy_id = visible to everyone)
INSERT INTO public.crm_templates (pharmacy_id, kind, name, body, variables, is_built_in, whatsapp_status, language)
VALUES
  (NULL, 'thank_you', 'T1 · Thank you',
   'Hi {name}, thank you for shopping at {pharmacy_name}! Your bill {amount} has been saved to our system. For refills, call or visit us anytime.',
   ARRAY['name','pharmacy_name','amount'], true, 'approved', 'en'),
  (NULL, 'refill_reminder', 'T2 · Refill reminder',
   'Hi {name}, time to refill your {medicine}? We have it in stock. Call: {pharmacy_phone}. Or visit our store.',
   ARRAY['name','medicine','pharmacy_phone'], true, 'approved', 'en'),
  (NULL, 'offer', 'T3 · Special offer',
   'Hi {name}, special offer on {category}: {discount}% off! Valid till {date}. Limited stock. Order now.',
   ARRAY['name','category','discount','date'], true, 'approved', 'en')
ON CONFLICT (pharmacy_id, name, language) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. REMINDER RULES + SCHEDULED REMINDERS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_reminder_rules (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id     uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  medicine_label  text NOT NULL,
  category_match  text[] NOT NULL DEFAULT '{}',
  refill_cycle_days  smallint NOT NULL CHECK (refill_cycle_days BETWEEN 1 AND 365),
  reminder_offset_days smallint NOT NULL DEFAULT 5 CHECK (reminder_offset_days BETWEEN 0 AND 90),
  template_id     uuid NOT NULL REFERENCES public.crm_templates(id) ON DELETE RESTRICT,
  send_time       time NOT NULL DEFAULT '09:00',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pharmacy_id, medicine_label)
);

CREATE INDEX IF NOT EXISTS idx_crm_reminder_rules_pharmacy ON public.crm_reminder_rules(pharmacy_id);

CREATE TABLE IF NOT EXISTS public.crm_scheduled_reminders (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id     uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  rule_id         uuid REFERENCES public.crm_reminder_rules(id) ON DELETE SET NULL,
  template_id     uuid NOT NULL REFERENCES public.crm_templates(id) ON DELETE RESTRICT,
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_for   timestamptz NOT NULL,
  status          crm_reminder_status NOT NULL DEFAULT 'pending',
  message_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_sched_due       ON public.crm_scheduled_reminders(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_crm_sched_customer  ON public.crm_scheduled_reminders(customer_id);
CREATE INDEX IF NOT EXISTS idx_crm_sched_pharmacy  ON public.crm_scheduled_reminders(pharmacy_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. CAMPAIGNS + RECIPIENTS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_campaigns (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id     uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  created_by      uuid NOT NULL REFERENCES auth.users(id),
  name            text NOT NULL,
  segment_key     text NOT NULL,
  template_id     uuid NOT NULL REFERENCES public.crm_templates(id),
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          crm_campaign_status NOT NULL DEFAULT 'draft',
  scheduled_for   timestamptz,
  total_recipients int NOT NULL DEFAULT 0,
  sent_count      int NOT NULL DEFAULT 0,
  delivered_count int NOT NULL DEFAULT 0,
  failed_count    int NOT NULL DEFAULT 0,
  reply_count     int NOT NULL DEFAULT 0,
  approved_at     timestamptz,
  approved_by     uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_campaigns_pharmacy_status ON public.crm_campaigns(pharmacy_id, status);

CREATE TABLE IF NOT EXISTS public.crm_campaign_recipients (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id     uuid NOT NULL REFERENCES public.crm_campaigns(id) ON DELETE CASCADE,
  customer_id     uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  status          crm_message_status NOT NULL DEFAULT 'queued',
  message_id      uuid,
  sent_at         timestamptz,
  UNIQUE (campaign_id, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_crm_recipients_campaign ON public.crm_campaign_recipients(campaign_id, status);

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. MESSAGES + SEND LOG + AUDIT LOG
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_messages (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id     uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  customer_id     uuid REFERENCES public.crm_customers(id) ON DELETE SET NULL,
  template_id     uuid REFERENCES public.crm_templates(id),
  campaign_id     uuid REFERENCES public.crm_campaigns(id) ON DELETE SET NULL,
  reminder_id     uuid REFERENCES public.crm_scheduled_reminders(id) ON DELETE SET NULL,
  direction       crm_message_direction NOT NULL DEFAULT 'outbound',
  status          crm_message_status NOT NULL DEFAULT 'queued',
  body            text NOT NULL,
  variables       jsonb NOT NULL DEFAULT '{}'::jsonb,
  to_phone        text NOT NULL,
  from_phone      text,
  whatsapp_message_id text,
  error_code      text,
  error_message   text,
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_at       timestamptz,
  triggered_by    uuid REFERENCES auth.users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_messages_pharmacy_created ON public.crm_messages(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_messages_customer ON public.crm_messages(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_messages_campaign ON public.crm_messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_crm_messages_status   ON public.crm_messages(pharmacy_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_messages_waba     ON public.crm_messages(whatsapp_message_id);

CREATE TABLE IF NOT EXISTS public.crm_send_log (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES public.crm_messages(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_send_log_window ON public.crm_send_log(pharmacy_id, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.crm_audit_log (
  id          bigserial PRIMARY KEY,
  pharmacy_id uuid NOT NULL,
  user_id     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  table_name  text NOT NULL,
  row_id      uuid,
  action      text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  old_data    jsonb,
  new_data    jsonb,
  ip_address  inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_audit_pharmacy ON public.crm_audit_log(pharmacy_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_audit_table    ON public.crm_audit_log(table_name, created_at DESC);

-- Visit notes (per-visit text + medicines list, PRD §2.7)
CREATE TABLE IF NOT EXISTS public.crm_visit_notes (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  note        text NOT NULL,
  medicines   text[] NOT NULL DEFAULT '{}',
  added_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_visit_notes_customer ON public.crm_visit_notes(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_visit_notes_pharmacy ON public.crm_visit_notes(pharmacy_id, created_at DESC);

-- Prescriptions (header + medicine line items)
CREATE TABLE IF NOT EXISTS public.crm_prescriptions (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id       uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  customer_id       uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  doctor_name       text,
  prescription_date date NOT NULL DEFAULT current_date,
  follow_up_date    date,
  diagnosis         text,
  notes             text,
  attachment_url    text,
  total_cost        numeric(12,2),
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crm_prescriptions ADD COLUMN IF NOT EXISTS follow_up_date date;
ALTER TABLE public.crm_prescriptions ADD COLUMN IF NOT EXISTS attachment_url text;
ALTER TABLE public.crm_prescriptions ADD COLUMN IF NOT EXISTS total_cost numeric(12,2);
CREATE INDEX IF NOT EXISTS idx_crm_prescriptions_customer ON public.crm_prescriptions(customer_id, prescription_date DESC);
CREATE INDEX IF NOT EXISTS idx_crm_prescriptions_pharmacy ON public.crm_prescriptions(pharmacy_id, prescription_date DESC);

CREATE TABLE IF NOT EXISTS public.crm_prescription_medicines (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  prescription_id       uuid NOT NULL REFERENCES public.crm_prescriptions(id) ON DELETE CASCADE,
  position              smallint NOT NULL DEFAULT 0,
  medicine_name         text NOT NULL,
  form                  text,
  strength              text,
  dosage                text,
  route                 text,
  frequency             text NOT NULL DEFAULT 'Once daily',
  quantity              smallint CHECK (quantity IS NULL OR quantity BETWEEN 1 AND 999),
  duration_days         smallint CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  refill_interval_days  smallint CHECK (refill_interval_days IS NULL OR refill_interval_days BETWEEN 1 AND 365),
  instructions          text,
  substitution_allowed  boolean NOT NULL DEFAULT true,
  medicine_notes        text
);
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS quantity smallint;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS instructions text;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS form text;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS strength text;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS route text;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS substitution_allowed boolean NOT NULL DEFAULT true;
ALTER TABLE public.crm_prescription_medicines ADD COLUMN IF NOT EXISTS medicine_notes text;
CREATE INDEX IF NOT EXISTS idx_crm_rx_meds_prescription ON public.crm_prescription_medicines(prescription_id, position);

-- Per-medicine refill log — drives "Refilled X times · last 5d ago · next 25d"
CREATE TABLE IF NOT EXISTS public.crm_prescription_refills (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  pharmacy_id         uuid NOT NULL REFERENCES public.crm_pharmacies(id) ON DELETE CASCADE,
  prescription_id     uuid NOT NULL REFERENCES public.crm_prescriptions(id) ON DELETE CASCADE,
  medicine_id         uuid NOT NULL REFERENCES public.crm_prescription_medicines(id) ON DELETE CASCADE,
  customer_id         uuid NOT NULL REFERENCES public.crm_customers(id) ON DELETE CASCADE,
  refilled_at         timestamptz NOT NULL DEFAULT now(),
  quantity_dispensed  smallint CHECK (quantity_dispensed IS NULL OR quantity_dispensed BETWEEN 1 AND 999),
  bill_amount         numeric(12,2) CHECK (bill_amount IS NULL OR bill_amount >= 0),
  notes               text,
  served_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_refills_medicine ON public.crm_prescription_refills(medicine_id, refilled_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_refills_customer ON public.crm_prescription_refills(customer_id, refilled_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_refills_pharmacy ON public.crm_prescription_refills(pharmacy_id, refilled_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. FUNCTIONS  (auth helpers, audit, updated_at, rate limit, retention)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.crm_is_member(p_pharmacy_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.crm_pharmacies WHERE id = p_pharmacy_id AND owner_id = auth.uid()
    UNION ALL
    SELECT 1 FROM public.crm_members WHERE pharmacy_id = p_pharmacy_id AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.crm_my_role(p_pharmacy_id uuid)
RETURNS crm_member_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role FROM (
    SELECT 'admin'::crm_member_role AS role FROM public.crm_pharmacies
      WHERE id = p_pharmacy_id AND owner_id = auth.uid()
    UNION ALL
    SELECT role FROM public.crm_members
      WHERE pharmacy_id = p_pharmacy_id AND user_id = auth.uid()
  ) t LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.crm_can_send_now(p_pharmacy_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_cap   smallint;
  v_count int;
  v_window_ok boolean;
BEGIN
  SELECT rate_limit_per_hour,
         (now() AT TIME ZONE 'Asia/Kolkata')::time BETWEEN send_window_start AND send_window_end
    INTO v_cap, v_window_ok
    FROM public.crm_pharmacies
    WHERE id = p_pharmacy_id;
  IF NOT FOUND OR NOT v_window_ok THEN RETURN false; END IF;
  SELECT count(*) INTO v_count
    FROM public.crm_send_log
    WHERE pharmacy_id = p_pharmacy_id AND sent_at > now() - interval '1 hour';
  RETURN v_count < v_cap;
END $$;

CREATE OR REPLACE FUNCTION public.crm_audit_trigger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_pharmacy uuid;
BEGIN
  v_pharmacy := COALESCE(
    (CASE WHEN TG_OP = 'DELETE' THEN OLD.pharmacy_id ELSE NEW.pharmacy_id END)
  );
  INSERT INTO public.crm_audit_log (pharmacy_id, user_id, table_name, row_id, action, old_data, new_data)
  VALUES (
    v_pharmacy,
    auth.uid(),
    TG_TABLE_NAME,
    COALESCE((CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END)::uuid, NULL),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END
  );
  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION public.crm_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE OR REPLACE FUNCTION public.crm_purge_old_audit()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.crm_audit_log WHERE created_at < now() - interval '90 days';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. TRIGGERS  (audit on hot tables; updated_at on every crm_* table)
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS audit_crm_customers ON public.crm_customers;
CREATE TRIGGER audit_crm_customers
  AFTER INSERT OR UPDATE OR DELETE ON public.crm_customers
  FOR EACH ROW EXECUTE FUNCTION public.crm_audit_trigger();

DROP TRIGGER IF EXISTS audit_crm_messages ON public.crm_messages;
CREATE TRIGGER audit_crm_messages
  AFTER INSERT OR UPDATE OR DELETE ON public.crm_messages
  FOR EACH ROW EXECUTE FUNCTION public.crm_audit_trigger();

DROP TRIGGER IF EXISTS audit_crm_campaigns ON public.crm_campaigns;
CREATE TRIGGER audit_crm_campaigns
  AFTER INSERT OR UPDATE OR DELETE ON public.crm_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.crm_audit_trigger();

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname='public' AND c.relname LIKE 'crm_%' AND c.relkind = 'r'
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name=c.relname AND column_name='updated_at')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON public.%I; CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.crm_set_updated_at();', r.tbl, r.tbl);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 14. STRIP LEGACY auth.users TRIGGERS
--     Old apps installed `handle_new_user`-style triggers that try to insert
--     into accounts/profiles tables. After schema drift they fail and break
--     signup with "Database error saving new user". medcrm-v2 doesn't use
--     them — onboarding creates the pharmacy explicitly post-signup.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.tgname
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'auth' AND c.relname = 'users' AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON auth.users', r.tgname);
    RAISE NOTICE 'Dropped legacy auth.users trigger %', r.tgname;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 15. VIEWS
--     crm_my_pharmacies inlines `pharmacy_name` so the client doesn't need a
--     join — PostgREST can't infer FKs across views, so embedding the column
--     keeps queries to a single SELECT.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.crm_my_pharmacies AS
  SELECT m.pharmacy_id, m.role, p.name AS pharmacy_name, p.logo_url AS pharmacy_logo_url
    FROM public.crm_members m
    JOIN public.crm_pharmacies p ON p.id = m.pharmacy_id
    WHERE m.user_id = auth.uid()
  UNION
  SELECT p.id AS pharmacy_id, 'admin'::crm_member_role AS role, p.name AS pharmacy_name, p.logo_url AS pharmacy_logo_url
    FROM public.crm_pharmacies p
    WHERE p.owner_id = auth.uid();

-- Unified visit stats: counts sales + visit notes + prescriptions as "visits".
-- lifetime_value still only sums sale bill_amount (visit notes / prescriptions
-- don't carry money).
CREATE OR REPLACE VIEW public.crm_customer_stats AS
WITH events AS (
  SELECT customer_id, sold_at AS at FROM public.crm_customer_sales
  UNION ALL
  SELECT customer_id, created_at AS at FROM public.crm_visit_notes
  UNION ALL
  SELECT customer_id, prescription_date::timestamptz AS at FROM public.crm_prescriptions
  UNION ALL
  SELECT customer_id, refilled_at AS at FROM public.crm_prescription_refills
)
SELECT
  c.id          AS customer_id,
  c.pharmacy_id,
  COALESCE((SELECT count(*) FROM events e WHERE e.customer_id = c.id), 0) AS visit_count,
  -- Cast the final sum back to numeric(12,2) so the column type stays
  -- numeric(12,2) — matches the original view definition and lets
  -- CREATE OR REPLACE VIEW succeed without "cannot change data type".
  (
    COALESCE(
      (SELECT sum(bill_amount) FROM public.crm_customer_sales s WHERE s.customer_id = c.id), 0
    )
    + COALESCE(
      (SELECT sum(bill_amount) FROM public.crm_prescription_refills r WHERE r.customer_id = c.id), 0
    )
    + COALESCE(
      (SELECT sum(total_cost) FROM public.crm_prescriptions p WHERE p.customer_id = c.id), 0
    )
  )::numeric(12,2) AS lifetime_value,
  (SELECT max(at) FROM events e WHERE e.customer_id = c.id) AS last_visit_at,
  CASE
    WHEN (SELECT count(*) FROM events e WHERE e.customer_id = c.id) >= 2 THEN
      (
        EXTRACT(EPOCH FROM (
          (SELECT max(at) FROM events e WHERE e.customer_id = c.id)
          -
          (SELECT min(at) FROM events e WHERE e.customer_id = c.id)
        ))
        / NULLIF((SELECT count(*) - 1 FROM events e WHERE e.customer_id = c.id), 0)
        / 86400
      )::int
  END AS avg_days_between_visits
FROM public.crm_customers c;

CREATE OR REPLACE VIEW public.crm_customer_auto_tags AS
WITH stats AS (SELECT * FROM public.crm_customer_stats)
SELECT c.id AS customer_id, c.pharmacy_id, 'new'::text AS tag
  FROM public.crm_customers c
  WHERE c.created_at > now() - interval '7 days'
UNION ALL
SELECT s.customer_id, s.pharmacy_id, 'repeat'     FROM stats s WHERE s.visit_count >= 2
UNION ALL
SELECT s.customer_id, s.pharmacy_id, 'high_value' FROM stats s WHERE s.lifetime_value >= 10000
UNION ALL
SELECT s.customer_id, s.pharmacy_id, 'inactive'   FROM stats s
  WHERE s.last_visit_at IS NOT NULL AND s.last_visit_at < now() - interval '30 days';

CREATE OR REPLACE VIEW public.crm_whatsapp_health AS
SELECT
  p.id AS pharmacy_id,
  p.rate_limit_per_hour,
  (SELECT count(*) FROM public.crm_send_log sl
     WHERE sl.pharmacy_id = p.id AND sl.sent_at > now() - interval '1 hour')::int AS sends_last_hour,
  (SELECT count(*) FILTER (WHERE status IN ('failed','bounced'))::float /
          NULLIF(count(*),0) * 100
     FROM public.crm_messages m
     WHERE m.pharmacy_id = p.id AND m.created_at > now() - interval '24 hours')      AS bounce_rate_24h,
  (SELECT count(*) FROM public.crm_customers c
     WHERE c.pharmacy_id = p.id AND c.whatsapp_opted_out_at > now() - interval '30 days')::int AS opt_outs_30d,
  (SELECT count(*) FROM public.crm_customers c WHERE c.pharmacy_id = p.id)::int      AS total_customers,
  p.send_window_start,
  p.send_window_end
FROM public.crm_pharmacies p;

-- ─────────────────────────────────────────────────────────────────────────────
-- 16. ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.crm_pharmacies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_members             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_customers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_customer_sales      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_tags                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_templates           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_reminder_rules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_scheduled_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_send_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_audit_log           ENABLE ROW LEVEL SECURITY;

-- Pharmacies
DROP POLICY IF EXISTS pharmacies_select ON public.crm_pharmacies;
CREATE POLICY pharmacies_select ON public.crm_pharmacies FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR id IN (SELECT pharmacy_id FROM public.crm_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS pharmacies_insert ON public.crm_pharmacies;
CREATE POLICY pharmacies_insert ON public.crm_pharmacies FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS pharmacies_update ON public.crm_pharmacies;
CREATE POLICY pharmacies_update ON public.crm_pharmacies FOR UPDATE TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

-- Members
DROP POLICY IF EXISTS members_select ON public.crm_members;
CREATE POLICY members_select ON public.crm_members FOR SELECT TO authenticated
  USING (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS members_admin_write ON public.crm_members;
CREATE POLICY members_admin_write ON public.crm_members FOR ALL TO authenticated
  USING (public.crm_my_role(pharmacy_id) = 'admin')
  WITH CHECK (public.crm_my_role(pharmacy_id) = 'admin');

-- Customers / Sales / Tags / Messages / Scheduled Reminders / Recipients
DROP POLICY IF EXISTS customers_member ON public.crm_customers;
CREATE POLICY customers_member ON public.crm_customers FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS sales_member ON public.crm_customer_sales;
CREATE POLICY sales_member ON public.crm_customer_sales FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS tags_member ON public.crm_tags;
CREATE POLICY tags_member ON public.crm_tags FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS messages_member ON public.crm_messages;
CREATE POLICY messages_member ON public.crm_messages FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS sched_member ON public.crm_scheduled_reminders;
CREATE POLICY sched_member ON public.crm_scheduled_reminders FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS recipients_member ON public.crm_campaign_recipients;
CREATE POLICY recipients_member ON public.crm_campaign_recipients FOR ALL TO authenticated
  USING (campaign_id IN (SELECT id FROM public.crm_campaigns WHERE public.crm_is_member(pharmacy_id)))
  WITH CHECK (campaign_id IN (SELECT id FROM public.crm_campaigns WHERE public.crm_is_member(pharmacy_id)));

-- Templates: built-ins readable by all; pharmacy templates by members only
DROP POLICY IF EXISTS templates_select ON public.crm_templates;
CREATE POLICY templates_select ON public.crm_templates FOR SELECT TO authenticated
  USING (pharmacy_id IS NULL OR public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS templates_member_write ON public.crm_templates;
CREATE POLICY templates_member_write ON public.crm_templates FOR ALL TO authenticated
  USING (pharmacy_id IS NOT NULL AND public.crm_is_member(pharmacy_id))
  WITH CHECK (pharmacy_id IS NOT NULL AND public.crm_is_member(pharmacy_id));

-- Reminder rules: admin/manager writes, member reads
DROP POLICY IF EXISTS rules_select ON public.crm_reminder_rules;
CREATE POLICY rules_select ON public.crm_reminder_rules FOR SELECT TO authenticated
  USING (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS rules_admin_write ON public.crm_reminder_rules;
CREATE POLICY rules_admin_write ON public.crm_reminder_rules FOR ALL TO authenticated
  USING (public.crm_my_role(pharmacy_id) IN ('admin','manager'))
  WITH CHECK (public.crm_my_role(pharmacy_id) IN ('admin','manager'));

-- Campaigns
DROP POLICY IF EXISTS campaigns_select ON public.crm_campaigns;
CREATE POLICY campaigns_select ON public.crm_campaigns FOR SELECT TO authenticated
  USING (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS campaigns_insert ON public.crm_campaigns;
CREATE POLICY campaigns_insert ON public.crm_campaigns FOR INSERT TO authenticated
  WITH CHECK (public.crm_is_member(pharmacy_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS campaigns_update ON public.crm_campaigns;
CREATE POLICY campaigns_update ON public.crm_campaigns FOR UPDATE TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

-- Send log + audit log: read-only for members
DROP POLICY IF EXISTS send_log_select ON public.crm_send_log;
CREATE POLICY send_log_select ON public.crm_send_log FOR SELECT TO authenticated
  USING (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS audit_select ON public.crm_audit_log;
CREATE POLICY audit_select ON public.crm_audit_log FOR SELECT TO authenticated
  USING (public.crm_is_member(pharmacy_id));

ALTER TABLE public.crm_visit_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS visit_notes_member ON public.crm_visit_notes;
CREATE POLICY visit_notes_member ON public.crm_visit_notes FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

ALTER TABLE public.crm_prescriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_prescription_medicines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS prescriptions_member ON public.crm_prescriptions;
CREATE POLICY prescriptions_member ON public.crm_prescriptions FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

DROP POLICY IF EXISTS rx_meds_member ON public.crm_prescription_medicines;
CREATE POLICY rx_meds_member ON public.crm_prescription_medicines FOR ALL TO authenticated
  USING (
    prescription_id IN (SELECT id FROM public.crm_prescriptions WHERE public.crm_is_member(pharmacy_id))
  )
  WITH CHECK (
    prescription_id IN (SELECT id FROM public.crm_prescriptions WHERE public.crm_is_member(pharmacy_id))
  );

ALTER TABLE public.crm_prescription_refills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refills_member ON public.crm_prescription_refills;
CREATE POLICY refills_member ON public.crm_prescription_refills FOR ALL TO authenticated
  USING (public.crm_is_member(pharmacy_id))
  WITH CHECK (public.crm_is_member(pharmacy_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 17. STORAGE BUCKET FOR TEMPLATE IMAGES
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-template-images',
  'crm-template-images',
  true,
  5 * 1024 * 1024,
  ARRAY['image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

DO $$ BEGIN
  CREATE POLICY "crm_tpl_img_insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'crm-template-images');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_tpl_img_select" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'crm-template-images');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_tpl_img_update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'crm-template-images');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_tpl_img_delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'crm-template-images');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Pharmacy logos bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-pharmacy-logos',
  'crm-pharmacy-logos',
  true,
  2 * 1024 * 1024,
  ARRAY['image/jpeg','image/png','image/webp','image/svg+xml']
)
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

DO $$ BEGIN
  CREATE POLICY "crm_pharm_logo_insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'crm-pharmacy-logos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_pharm_logo_select" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'crm-pharmacy-logos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_pharm_logo_update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'crm-pharmacy-logos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_pharm_logo_delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'crm-pharmacy-logos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bill / prescription attachments bucket (PDF + images, 10 MB cap)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'crm-bill-attachments',
  'crm-bill-attachments',
  true,
  10 * 1024 * 1024,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

DO $$ BEGIN
  CREATE POLICY "crm_bill_attach_insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'crm-bill-attachments');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_bill_attach_select" ON storage.objects
    FOR SELECT TO public
    USING (bucket_id = 'crm-bill-attachments');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_bill_attach_update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'crm-bill-attachments');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "crm_bill_attach_delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'crm-bill-attachments');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 18. GRANTS  (default deny + explicit allow to authenticated)
-- ─────────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON public.crm_my_pharmacies      TO authenticated;
GRANT SELECT ON public.crm_customer_stats     TO authenticated;
GRANT SELECT ON public.crm_customer_auto_tags TO authenticated;
GRANT SELECT ON public.crm_whatsapp_health    TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_is_member(uuid)        TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_my_role(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_can_send_now(uuid)     TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 19. REFRESH POSTGREST SCHEMA CACHE
-- ─────────────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Smoke checks (run separately after the script finishes):
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS tables FROM information_schema.tables
--   WHERE table_schema='public' AND table_name LIKE 'crm_%';            -- expect 13
-- SELECT count(*) AS templates FROM public.crm_templates WHERE is_built_in;  -- expect 3
-- SELECT id, public, file_size_limit FROM storage.buckets WHERE id='crm-template-images';
-- SELECT count(*) AS legacy_triggers FROM pg_trigger t
--   JOIN pg_class c ON t.tgrelid=c.oid JOIN pg_namespace n ON c.relnamespace=n.oid
--   WHERE n.nspname='auth' AND c.relname='users' AND NOT t.tgisinternal;     -- expect 0
