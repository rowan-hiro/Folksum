# 6. Adopt Folksum as the complete pre-release product identity

Date: 2026-08-12

## Status

Accepted

## Context and Problem Statement

HearthWorth was selected before release, but its HW abbreviation was undesirable. The product is still unpublished, so retaining HWM-prefixed configuration or a legacy credential directory would create permanent compatibility debt without protecting users.

## Decision Drivers

* Establish one distinctive, easy-to-spell product identity before release
* Keep package, CLI, configuration, credentials, and internal symbols in one namespace
* Avoid permanent compatibility debt when no public contract exists

## Considered Options

* Keep HearthWorth and its HW abbreviation
* Use FIRE as the package and internal prefix despite its crowded financial meaning
* Adopt Folksum while retaining HWM compatibility identifiers
* Adopt Folksum with a complete pre-release identifier break

## Decision Outcome

Use Folksum as the product, npm package, and CLI name, with Financial Intelligence & Record Engine as its tagline. Use FOLKSUM_* for application environment variables, ~/.folksum/auth.json for credentials, and Folksum names for internal product-specific symbols, without compatibility aliases.

## Consequences

* All brand and internal identifiers can be coherent before the first release
* Existing local development configuration must be reconfigured and credentials moved manually; no fallback or automatic migration is provided
