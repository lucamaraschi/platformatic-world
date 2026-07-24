-- WUR calibration durability (arXiv:2607.13617 §6.4)
-- application_key = 'fleet' for cross-app prior, else external app_id string

CREATE TABLE workflow_wur_calibration (
  application_key VARCHAR NOT NULL,
  change_class    VARCHAR NOT NULL,
  exposures       INTEGER NOT NULL DEFAULT 0 CHECK (exposures >= 0),
  incidents       INTEGER NOT NULL DEFAULT 0 CHECK (incidents >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (application_key, change_class),
  CHECK (incidents <= exposures)
);

CREATE INDEX idx_wur_cal_class ON workflow_wur_calibration (change_class);
