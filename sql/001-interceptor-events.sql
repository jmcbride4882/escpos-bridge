-- escpos-bridge → Hetzner: stores every receipt + KP intercept.
-- Cross-references existing webhook_events via invoice number / TX time
-- to definitively distinguish Customer Credit vs Customer Points
-- (which the webhook payload omits — only Cash + Card visible there).
--
-- Run on the lsltapps DB (where webhook_events also lives, for joins).

CREATE TABLE IF NOT EXISTS interceptor_events (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,                                     -- 'receipt' | 'kp'
  venue       TEXT NOT NULL,                                     -- '19th-hole', 'snack-shack', 'lakeside'
  device_id   TEXT NOT NULL,                                     -- 'pi5-19th-1'
  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  invoice     TEXT,                                              -- 'T-8712-1 F2-00000002' (receipt only)
  ticket      TEXT,                                              -- 'A - 3' (receipt only)
  staff       TEXT,
  till_device TEXT,                                              -- 'Till7' (free-text from receipt header)
  total       NUMERIC(10,2),                                     -- receipt only
  customer_barcode TEXT,                                         -- 'RECB000022IW07UWZ6K8W' (receipt only)
  raw_size    INTEGER,
  raw_b64     TEXT,                                              -- base64 of original ESC/POS bytes
  payload     JSONB NOT NULL,                                    -- full extracted object
  -- Cross-ref columns (populated by trigger or app on insert)
  matched_eposnow_tx_id BIGINT,
  drift_detected        BOOLEAN DEFAULT FALSE,
  drift_notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_intercept_kind_at  ON interceptor_events (kind, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_intercept_invoice  ON interceptor_events (invoice) WHERE invoice IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intercept_barcode  ON interceptor_events (customer_barcode) WHERE customer_barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intercept_drift    ON interceptor_events (drift_detected, received_at DESC) WHERE drift_detected = TRUE;
