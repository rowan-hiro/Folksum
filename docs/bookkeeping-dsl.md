# Bookkeeping customization DSL

Folksum's bookkeeping DSL is a non-executable, revision-aware overlay for the
semantic bookkeeping profile. It is intended to live outside the public Folksum
repository, for example in a private household configuration repository. The
public application owns the parser, compiler, validation, and activation path;
the private file owns household-specific declarations such as participant names,
merchant matches, account IDs, and export layouts.

The DSL cannot alter the physical SQLite schema or accounting behavior. It has no
file includes, environment interpolation, SQL, templates, or executable code.
Every document compiles into the same profile patch model used by the agent and
then passes through the existing profile validator.

## Commands

Validate a file against the active profile without activating a new profile
revision:

```sh
folksum profile check-dsl path/to/household.folksum
```

Explicitly activate the compiled profile as a new immutable revision:

```sh
folksum profile apply-dsl path/to/household.folksum
```

Both commands default to `.data/bookkeeping.folksum` when the path is omitted.
`expected-revision` must equal the active revision, so a stale private file cannot
overwrite a newer file or agent update. After a successful activation, update
the document to the returned `expectedRevision` before using it again. Folksum
never rewrites the private DSL source file.

For example, a successful activation writes one JSON object to standard output:

```json
{
  "status": "activated",
  "revision": 1,
  "profileHash": "...",
  "expectedRevision": 1
}
```

Replace only the directive's numeric value in the private file:

```text
expected-revision 1
```

Comments and all other declarations remain under the user's control. Until the
directive is updated, a later `check-dsl` or `apply-dsl` rejects the file as
stale. The active SQLite profile revision, not the external file, is the runtime
source of truth.

## Document structure

The header and compatibility metadata are required:

```text
folksum-bookkeeping 1
expected-revision 0
extends folksum/default@1
```

Blank lines and comments beginning with `#` are ignored. User-facing text and
account IDs are JSON-style quoted strings. Declaration IDs and enum values are
unquoted tokens. A document must contain at least one declaration or removal.

Declarations upsert items by ID into the active profile. Removals are explicit:

```text
remove category expense.travel
remove field reimbursable
remove rule merchant.coffee
remove export accountant.csv
```

The compiler rejects duplicate IDs, unknown removals, dangling references,
invalid category hierarchies, unsupported export columns, incompatible field
values, and all other violations enforced by the semantic profile validator.

## Categories

```text
category expense.food.coffee {
  label "Coffee"
  kind expense
  parent expense.food
  account HKD "account-id-from-the-local-database"
}
```

`label` and `kind` are required. `kind` is `expense` or `income`. `parent` is
optional. Repeat `account` for currency-specific bindings. Account IDs are private
deployment values and must resolve to compatible open accounts at activation.

## Transaction fields

```text
field participant {
  label "Participant"
  type text
  required false
  values "self" "partner" "shared"
}
```

`label` and `type` are required. Supported types are `text`, `boolean`, `integer`,
and `date`. `required` defaults to `false`. `values` is available only for text
fields and accepts one or more quoted values. Fields currently target transactions.

## Deterministic categorization rules

```text
rule merchant.coffee {
  priority 80
  when expense description contains "coffee shop"
  category expense.food.coffee
  field participant "shared"
}
```

`priority` and `when` are required. A rule must assign a category, one or more
fields, or both. Field values can be quoted text, `true`, `false`, or a safe
integer. Date fields use quoted `YYYY-MM-DD` text. Rules are normalized and sorted
by descending priority, then ID, by the existing profile validator.

Version 1 match predicates are `description contains`, exact-money `amount`
bounds, `amount-per-person` with an explicit participant count, and boolean
`all` / `any` / `not` composition. Nested `all` / `any` / `not` blocks are
allowed inside a rule. Amount bounds are quoted decimals compared in the
transaction currency, so a bound with more fractional digits than that currency
supports never matches it; `explain_bookkeeping_match` reports such a rule as
`amountUnrepresentable` rather than as a missed amount. That state propagates
through boolean composition using three-valued logic: `not` preserves it, while
`all` and `any` propagate it unless another branch definitively determines the
result. Capture shortcuts expand into structured capture input:

```text
category expense.transport.taxi {
  label "Taxi"
  kind expense
  parent expense.transport
}

shortcut transit.bus {
  label "Bus"
  kind expense
  description "巴士"
  amount "5.00"
  category expense.transport
}

rule taxi.shared {
  priority 250
  when expense all {
    description contains "的士"
    amount-per-person 2 gte "50"
  }
  category expense.transport.taxi
}
```

## Declarative exports

```text
export daily.csv {
  label "Daily CSV"
  format csv
  rows postings
  reversals exclude
  amount-sign absolute
  delimiter ","
  utf8-bom true
  category expense.food.coffee
  account "account-id-from-the-local-database"
  source agent
  source manual
  column "Date" transaction.date date-format dd/mm/yyyy
  column "Description" transaction.description
  column "Amount" posting.amount
  column "Kind" literal "expense"
  column "Participant" customFields.participant
}
```

Required directives are `label`, `format`, `rows`, `reversals`, `amount-sign`,
and at least one `column`. Repeat `category`, `account`, and `source` to build
filters. CSV delimiters are comma, semicolon, or tab. Optional `utf8-bom true`
prefixes CSV output. Columns may use a source, a `literal` string, an allowlisted
`date-format`, and `amount-role` (`pnl`, `funding`, `debit`, or `credit`) for
`transaction.amount` in transaction row mode. Column sources use the same
allow-list as JSON profile exports; transaction row mode cannot select posting
columns.

## Public and private boundary

The public repository should contain:

- DSL grammar, parser, compiler, validation, and tests.
- Generic matching operators, field types, export primitives, and documentation.
- Migration logic and application-owned safety policy.

A private household module should contain:

- People and household-specific field values.
- Merchant names, shortcuts, and category mappings specific to the household.
- Local account IDs and provider-independent aliases.
- Private export layouts and operational preferences.

When a private need cannot be expressed, first decide whether the missing
primitive would be useful across households. Add reusable primitives to Folksum;
keep the concrete declaration and data in the private module.
