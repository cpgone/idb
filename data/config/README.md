# Config Files Reference

This folder contains runtime and UI configuration for the dashboard.

## JSON Files

### `announcement.json`
- Purpose: Controls the top announcement banner.
- Main keys:
- `enabled`: show/hide banner.
- `id`: stable announcement identifier.
- `message`: banner text.
- `bgClass` / `textClass`: styling classes.
- `linkText` / `linkHref`: optional CTA link.

### `author-alternate-name-exclusions.json`
- Purpose: Exclude known false-positive author-name matches.
- Main keys:
- `byOpenAlexId`: exclusions scoped by OpenAlex author ID.
- `byAuthorId`: exclusions scoped by internal author ID.
- `global`: exclusions applied system-wide.

### `dashboardConfig.json`
- Purpose: Main page and author-detail defaults plus dashboard visibility toggles.
- Main keys:
- `showStats`, `showCharts`: section visibility on dashboard.
- `mainPageDefaults`: defaults for dashboard filters.
- `authorDetailDefaults`: defaults for author page filters.
- `statCards`: per-card visibility toggles.
- See also: `data/config/dashboardConfig.README.md` for detailed field docs.

### `insightsconfig.json`
- Purpose: Insights logic and defaults.
- Main keys:
- `defaultYearRange`, `defaultYearRangePages`, `defaultYearRangeCharts`: range defaults.
- `insightsDefaultPeriodA`, `insightsDefaultPeriodB`: comparison periods.
- `insightsDefault*`: default UI options (metric, scale, compare, chart/legend).
- `authorTop*Count`: author insights list limits.

### `institution-filters.json`
- Purpose: Named institution filter presets used in pages with institution filtering.
- Main keys:
- `default`: default preset ID.
- `options`: preset definitions (`id`, `label`, `shortLabel`, `match`, `institutions`, `institutionGroups`).

### `retracted-articles.json`
- Purpose: Retracted/exclusion lists used by publication filtering.
- Main keys:
- `dois`: DOIs treated as retracted.
- `workIds`: work IDs treated as retracted.
- `excludeDois`, `excludeWorkIds`: explicit overrides to avoid false positives.

### `siteinfo.json`
- Purpose: Site-level metadata and navigation defaults.
- Main keys:
- `title`, `shortTitle`, `tagline`, `description`, `author`.
- `logoSrc`, `faviconSrc`.
- `defaultVenueType`.
- `activeTheme`, `enableThemeSelection`.
- `navLinks`.

### `themes.json`
- Purpose: Theme definitions available to the app.
- Main keys:
- `themes`: array of theme objects.

## Notes

- JSON does not support comments. Use README files in this folder for documentation.
- Prefer stable IDs (for example institution preset `id`) over labels when configuring defaults.
