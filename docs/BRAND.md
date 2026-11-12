# Brand

The app looks like the Veracode Platform, so it feels like part of it. `images/` has the reference screenshots: the All Applications page in light and dark.

## Themes

Dark is built first. Light comes later: the tokens below are ready for it, but the app only ships the dark set until we pick it up. All colors live as CSS variables in `dashboard/src/styles/tokens.css`, so adding light means adding a `[data-theme="light"]` block and a toggle in the top bar.

## Fonts

From Google Fonts:

- **Headings and body**: Inter
- **IDs and code**: JetBrains Mono

## Colors

| Token            | Dark      | Light (later)  | Use                                               |
| ---------------- | --------- | -------------- | ------------------------------------------------- |
| `--bg`           | `#1f1f1f` | `#f5f6f8`      | Page background                                   |
| `--bg-header`    | `#191919` | `#f7f8fa`      | Top navigation bar                                |
| `--panel`        | `#2a2a2a` | `#ffffff`      | Panels, filter column, table card                 |
| `--panel-raised` | `#3a3a3a` | `#f0f1f3`      | Table header, menus                               |
| `--line`         | `#3d3d3d` | `#e3e5e8`      | Row dividers, the line under the top bar          |
| `--text`         | `#ffffff` | `#212121`      | Body text                                         |
| `--text-muted`   | `#b8b8b8` | `#5f6368`      | Labels, filter group names                        |
| `--primary`      | `#00b3e6` | `#00b3e6`      | Primary buttons, outline buttons, focus           |
| `--link`         | `#1fa9de` | `#0a8fc2`      | Links in tables                                   |
| `--success`      | `#8bc34a` | `#c5e17a` fill | "Active" pill (outlined in dark, filled in light) |
| `--danger`       | `#e5484d` | `#d32f2f`      | Delete, errors, the policy shield                 |
| `--warning`      | `#f5a623` | `#b26a00`      | "Inactive" and warnings                           |

## Sign-in page

Styled on the Veracode sign-in page (`images/Screenshot 2026-11-09 131323.png`): a black page, a slanted blue gradient stripe, a large uppercase headline on the left, and "Sign in" with a username field, then a password field, and a blue button on the right. Tokens: `--signin-bg`, `--signin-blue`, `--signin-field`, `--stripe-top` and `--stripe-bottom`.

It must never pass for the real thing: a large "Un-official" badge sits above the headline, a warning above the form says this is not a Veracode login and not to use a Veracode password, and the headline and wordmark are our own ("Manage your users", "User Manager"), not Veracode's. The top bar carries a small "Un-official" badge on every page.

## Components

- **Top bar**: the V mark, then the navigation in bold with a chevron for menus, then notifications, settings, help and the connected organization on the right.
- **Page header**: a breadcrumb (`Home /`), then a large bold title.
- **Buttons**: uppercase, bold, letter-spaced. Primary is solid `--primary` with dark text. Secondary (Actions) is `--panel-raised` with a caret. Outline (Filters) has a `--primary` border.
- **Filters**: a left column with "Applied Filters", a "Clear All" link, chips for active filters, and collapsible groups in small uppercase.
- **Table**: in a rounded `--panel` card, a `--panel-raised` header row with bold small labels and sort arrows, rows split by `--line`, names as links, a "..." menu per row, and a footer with the count, page controls and rows per page.
- **Status pills**: small rounded rectangles; outlined in dark.

## Tone

Plain business English in US spelling, like the Veracode Platform. Short labels, no exclamation marks. Dates as "2 Nov 2026 4:50PM".
