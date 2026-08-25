-- Example rows only, so the board isn't empty on first run.
-- Replace with the real style/category list before Phase 4 needs to route anything.

INSERT INTO categories (name, meta_campaign_id, meta_ad_set_id, notes) VALUES
  ('Outerwear', NULL, NULL, 'Placeholder — set real Meta campaign/ad set IDs before Phase 4'),
  ('Knitwear', NULL, NULL, 'Placeholder — set real Meta campaign/ad set IDs before Phase 4')
ON CONFLICT (name) DO NOTHING;

INSERT INTO styles (style_code, name, tier, category_id) VALUES
  ('WNDRR-EXAMPLE-001', 'Example Core Style', 'core_proven', (SELECT id FROM categories WHERE name = 'Outerwear')),
  ('WNDRR-EXAMPLE-002', 'Example New Drop Style', 'new_drop', (SELECT id FROM categories WHERE name = 'Knitwear'))
ON CONFLICT (style_code) DO NOTHING;
