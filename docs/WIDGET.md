# Embeddable help widget v1

Add the privacy-first guided finder to a website you control:

```html
<script src="https://world-emergency-hotlines-production.up.railway.app/widget/v1/hotlines-widget.js" defer></script>
<world-emergency-hotlines country="us" category="mental_health" max-results="6"></world-emergency-hotlines>
```

The script registers a Shadow DOM custom element. It fetches the public static API manifest, one selected country artifact, and the shared resolver. Country, locality, need, and channel resolution stays in the visitor's browser; the project does not receive those selections as queries.

## Attributes

- `country`: optional lowercase ISO alpha-2 initial country
- `category`: optional canonical category slug
- `channel`: `any`, `phone`, `text`, or `chat`
- `locality`: optional initial complete recorded geography component
- `max-results`: 1–12, default 6
- `heading`: custom visible heading
- `api-base`: alternate HTTP(S) API v1 base; defaults to the widget script's origin

The element dispatches `weh-results` after resolution. `event.detail` contains country code, scope, fallback boolean, and stable result IDs—never the typed locality.

## Styling

Shadow DOM prevents host CSS collisions. Set CSS custom properties on the element: `--weh-accent`, `--weh-danger`, `--weh-bg`, `--weh-fg`, `--weh-muted`, and `--weh-border`.

## CSP and network access

Allow the widget origin in `script-src` and `connect-src`. The custom element installs its Shadow DOM stylesheet at runtime, so a strict host policy must also allow inline styles (for example `style-src 'unsafe-inline'`) or provide an equivalent policy accepted by the target browsers. The official API serves successful GET/HEAD artifacts with open CORS. No cookies or API key are used. Avoid attributes derived from private user data in server-rendered HTML.

## Accessibility

The widget uses native labelled inputs, fieldset/legend channel controls, keyboard-native actions, status/live messaging, focusable results, and text explanations rather than colour alone. Integrators must keep adequate surrounding contrast and must not hide the immediate-danger guidance.

## Safety and limitations

- Listings are source-backed records, not live availability checks, medical advice, or eligibility guarantees.
- Scope describes recorded geography only.
- Deprecated records are excluded by the shared resolver.
- Unknown/network-failed artifacts produce an in-widget error.
- Keep an appropriate non-digital emergency fallback in the host product.
- Pin `/widget/v1/`; incompatible changes require a new major path.
