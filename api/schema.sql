-- Paulsen Bygganalyse: grunnstruktur for Railway PostgreSQL.
-- Kjor pa en separat PostgreSQL-database. Ingen autentisering er aktivert av dette skjemaet.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS portal_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','employee','customer')),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  organization_number text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- En kunde kan ha flere brukere; en bruker kan representere flere kunder.
CREATE TABLE IF NOT EXISTS customer_memberships (
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  PRIMARY KEY (customer_id,user_id)
);

CREATE TABLE IF NOT EXISTS properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  name text NOT NULL,
  address text NOT NULL,
  postal_code text,
  municipality text,
  cadastral_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,customer_id)
);
CREATE INDEX IF NOT EXISTS properties_customer_idx ON properties(customer_id);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id),
  created_by uuid NOT NULL REFERENCES portal_users(id),
  title text NOT NULL,
  report_type text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','review','approved','published','archived')),
  content jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_by uuid REFERENCES portal_users(id),
  approved_at timestamptz,
  published_by uuid REFERENCES portal_users(id),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT published_requires_approval CHECK (
    status <> 'published' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND published_at IS NOT NULL)
  )
);
-- Stabilt, unikt løpenummer for prosjekter, også for eldre rapporter.
CREATE SEQUENCE IF NOT EXISTS report_number_seq;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_number bigint;
UPDATE reports SET report_number=nextval('report_number_seq') WHERE report_number IS NULL;
SELECT setval('report_number_seq',GREATEST(COALESCE((SELECT MAX(report_number) FROM reports),0),1),true);
ALTER TABLE reports ALTER COLUMN report_number SET DEFAULT nextval('report_number_seq');
ALTER TABLE reports ALTER COLUMN report_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_report_number_unique ON reports(report_number);

CREATE INDEX IF NOT EXISTS reports_property_idx ON reports(property_id);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status);

-- Arkiverer uforanderlige versjoner ved godkjenning/publisering.
CREATE TABLE IF NOT EXISTS report_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  content jsonb NOT NULL,
  pdf_storage_key text,
  created_by uuid NOT NULL REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(report_id,version_number)
);

CREATE TABLE IF NOT EXISTS report_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  storage_key text NOT NULL UNIQUE,
  original_name text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK(size_bytes >= 0),
  uploaded_by uuid NOT NULL REFERENCES portal_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Sikkerhetskrav for API-et:
-- 1. Kunder skal kun lese published-rapporter til eiendommer der de har medlemskap.
-- 2. Ansatte skal ikke kunne tildele seg selv roller eller kundetilganger.
-- 3. Alle endringer, godkjenninger og publiseringer autoriseres pa serveren.
-- 4. Filer lagres privat; nedlasting krever samme tilgangssjekk som rapporten.

-- Stabile nummer, også for eksisterende kunder og rapporter.
CREATE SEQUENCE IF NOT EXISTS customer_number_seq;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_number bigint;
ALTER TABLE customers ALTER COLUMN customer_number SET DEFAULT nextval('customer_number_seq');
UPDATE customers SET customer_number=nextval('customer_number_seq') WHERE customer_number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_number_unique ON customers(customer_number);

CREATE SEQUENCE IF NOT EXISTS report_number_seq;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_number bigint;
ALTER TABLE reports ALTER COLUMN report_number SET DEFAULT nextval('report_number_seq');
UPDATE reports SET report_number=nextval('report_number_seq') WHERE report_number IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS reports_number_unique ON reports(report_number);

CREATE TABLE IF NOT EXISTS quote_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 public_token text NOT NULL UNIQUE,
 customer_type text NOT NULL CHECK(customer_type IN ('private','business')),
 customer_name text NOT NULL,
 email text NOT NULL,
 phone text,
 organization_number text,
 property_address text NOT NULL,
 postal_code text,
 municipality text,
 gnr text,
 bnr text,
 building_type text,
 property_notes text,
 services jsonb NOT NULL,
 status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','priced','sent','accepted','declined')),
 line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
 discount_percent numeric(5,2) NOT NULL DEFAULT 0,
 price_display text NOT NULL DEFAULT 'incl' CHECK(price_display IN ('incl','excl')),
 offer_notes text,
 valid_until date,
 sent_at timestamptz,
 accepted_at timestamptz,
 customer_id uuid REFERENCES customers(id),
 property_id uuid REFERENCES properties(id),
 report_id uuid REFERENCES reports(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quote_requests_created_idx ON quote_requests(created_at DESC);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_name text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_email text;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_address text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_postal_code text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_city text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing_email text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS reference text;

ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS accepted_by_name text;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS accepted_by_email text;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS acceptance_ip text;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS acceptance_user_agent text;
ALTER TABLE quote_requests ADD COLUMN IF NOT EXISTS accepted_terms_snapshot jsonb;
