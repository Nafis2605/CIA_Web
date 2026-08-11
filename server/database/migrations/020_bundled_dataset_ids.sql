-- Migration: give bundled/built-in VTP datasets (public/vtp_files/manifest.json,
-- ids like "builtin-lungs") a real, stable server-side UUID row, so
-- annotations/measurements placed on them flow through the EXISTING
-- authorization/storage path in server/src/routes/annotations.js with no
-- special-casing of non-UUID ids anywhere in query logic.
--
-- authorizeAnnotationCreate() (annotations.js) already treats a dataset with
-- no file_project_access rows and a non-null public_path as accessible to
-- everyone — exactly the rule bundled datasets need — so no application code
-- changes are required once bundled ids resolve to real UUID rows via
-- GET /api/files/builtin (see server/src/routes/files.js).
--
-- organization_id/uploaded_by are left NULL: bundled datasets are shipped
-- assets, not upload-attributable to any user or org (both columns already
-- allow NULL — see server/database/init.sql).

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS builtin_key VARCHAR(100) UNIQUE;

INSERT INTO datasets (builtin_key, filename, file_type, file_size, public_path, status)
VALUES
  ('builtin-bones',        'Bones.vtp',       'vtp', 27272740, '/vtp_files/Bones.vtp',       'active'),
  ('builtin-lung-vessels', 'LungVessels.vtp', 'vtp', 28826464, '/vtp_files/LungVessels.vtp', 'active'),
  ('builtin-lungs',        'Lungs.vtp',       'vtp', 10750132, '/vtp_files/Lungs.vtp',       'active'),
  ('builtin-skull',        'Skull.vtp',       'vtp', 19988316, '/vtp_files/Skull.vtp',       'active'),
  ('builtin-ventricles',   'Ventricles.vtp',  'vtp', 16487240, '/vtp_files/Ventricles.vtp',  'active'),
  ('builtin-disk',         'diskout.vtp',     'vtp', 483237,   '/vtp_files/diskout.vtp',     'active'),
  ('builtin-earth',        'earth.vtp',       'vtp', 1233227,  '/vtp_files/earth.vtp',       'active')
ON CONFLICT (builtin_key) DO NOTHING;

-- ============================================================================
-- VERIFICATION
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'datasets' AND column_name = 'builtin_key'
    ) AND (SELECT COUNT(*) FROM datasets WHERE builtin_key IS NOT NULL) >= 7 THEN
        RAISE NOTICE 'Bundled dataset ids migration applied successfully';
    ELSE
        RAISE EXCEPTION 'Failed to apply bundled dataset ids migration';
    END IF;
END
$$;
