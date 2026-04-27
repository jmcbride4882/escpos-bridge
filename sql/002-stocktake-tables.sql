-- Stocktake schema (used by /admin/stock/:venue mobile form)
-- Replaces the manual PDF stocklist process.

CREATE TABLE IF NOT EXISTS venue_stocklist (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue                 TEXT NOT NULL,
  category              TEXT NOT NULL,
  product_label         TEXT NOT NULL,
  eposnow_product_id    BIGINT,
  unit_label            TEXT,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_supplier    TEXT,
  reorder_trigger_qty   NUMERIC(10,2),
  reorder_target_qty    NUMERIC(10,2),
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stocklist_venue ON venue_stocklist (venue, sort_order) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS stock_takes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue           TEXT NOT NULL,
  counted_by      TEXT,
  counted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'submitted',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_actions  JSONB,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_takes_venue_at ON stock_takes (venue, counted_at DESC);

CREATE TABLE IF NOT EXISTS stock_take_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_take_id UUID NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
  stocklist_id  UUID NOT NULL REFERENCES venue_stocklist(id),
  counted_qty   NUMERIC(10,2),
  need_flag     BOOLEAN NOT NULL DEFAULT FALSE,
  out_of_stock  BOOLEAN NOT NULL DEFAULT FALSE,
  notes         TEXT,
  sold_last_7d  INTEGER,
  sold_last_3d  INTEGER,
  last_sold_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stock_take_items_take ON stock_take_items (stock_take_id);
