(() => {
  'use strict';

  const script = document.currentScript;
  const scriptOrigin = script?.src ? new URL(script.src, document.baseURI).origin : window.location.origin;
  const TAG = 'world-emergency-hotlines';
  const CATEGORY_LABELS = {
    emergency: 'General emergency', suicide_crisis: 'Suicide & acute crisis', mental_health: 'Mental health',
    child_protection: 'Child protection', youth: 'Youth', domestic_violence: 'Domestic violence',
    sexual_violence: 'Sexual violence', lgbtqia: 'LGBTQIA+ support', substance_use: 'Substance use',
    elder_abuse: 'Elder abuse', veterans: 'Veterans', human_trafficking: 'Human trafficking',
    disaster: 'Disaster relief', missing_persons: 'Missing persons', bereavement: 'Bereavement',
    eating_disorders: 'Eating disorders', gambling: 'Gambling', self_harm: 'Self-harm', perinatal: 'Perinatal',
    disability: 'Disability', stalking: 'Stalking', male_victims: 'Male victims',
    refugee_migrant: 'Refugee & migrant', general_support: 'General support', legal_aid: 'Legal aid',
    animal_welfare: 'Animal welfare', human_rights: 'Human rights', financial_aid: 'Financial aid', housing: 'Housing',
    consular: 'Consular support',
  };

  const css = `
    :host{--weh-accent:#2563eb;--weh-danger:#b91c1c;--weh-bg:#fff;--weh-fg:#172033;--weh-muted:#596579;--weh-border:#d8dee8;display:block;color:var(--weh-fg);font:16px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}
    *{box-sizing:border-box}.shell{max-width:48rem;border:1px solid var(--weh-border);border-radius:1rem;background:var(--weh-bg);padding:1rem;box-shadow:0 8px 30px rgb(15 23 42/.08)}
    h2,h3,p{margin:0}.intro{margin:.35rem 0 1rem;color:var(--weh-muted);font-size:.9rem}.grid{display:grid;gap:.85rem}.row{display:grid;gap:.85rem}@media(min-width:38rem){.row{grid-template-columns:1fr 1fr}}
    label,legend{font-weight:650;font-size:.88rem}select,input,button{font:inherit}select,input{width:100%;margin-top:.3rem;border:1px solid var(--weh-border);border-radius:.55rem;background:var(--weh-bg);color:var(--weh-fg);padding:.65rem .7rem}
    fieldset{border:0;padding:0;margin:0}.channels{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:.4rem}.channels label{font-weight:500}.channels input{width:auto;margin:0 .25rem 0 0}
    button{border:0;border-radius:.6rem;background:var(--weh-accent);color:#fff;font-weight:700;padding:.72rem 1rem;cursor:pointer}button:hover{filter:brightness(.94)}button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid color-mix(in srgb,var(--weh-accent) 45%,transparent);outline-offset:2px}
    [hidden]{display:none!important}.status{margin-top:1rem;color:var(--weh-muted);font-size:.9rem}.notice{margin-top:1rem;border-left:4px solid var(--weh-accent);background:color-mix(in srgb,var(--weh-accent) 8%,var(--weh-bg));padding:.8rem}.notice.fallback{border-color:#b7791f}.notice strong{display:block;margin-bottom:.25rem}.emergency{margin-top:1rem;border:1px solid color-mix(in srgb,var(--weh-danger) 45%,var(--weh-border));border-radius:.75rem;background:color-mix(in srgb,var(--weh-danger) 7%,var(--weh-bg));padding:.85rem}.emergency h3{color:var(--weh-danger);font-size:1rem}
    .actions{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.55rem}a.action{display:inline-block;border-radius:.5rem;background:color-mix(in srgb,var(--weh-accent) 11%,var(--weh-bg));color:var(--weh-accent);padding:.45rem .65rem;text-decoration:none;font-weight:650}.emergency a.action{color:var(--weh-danger);background:color-mix(in srgb,var(--weh-danger) 12%,var(--weh-bg));font-size:1.1rem}
    .results{display:grid;gap:.75rem;margin-top:1rem}.card{border:1px solid var(--weh-border);border-radius:.75rem;padding:.85rem}.card h3{font-size:1rem}.meta{margin-top:.3rem;color:var(--weh-muted);font-size:.78rem}.evidence{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:.65rem;padding-top:.55rem;border-top:1px solid var(--weh-border);color:var(--weh-muted);font-size:.75rem}.evidence a{color:var(--weh-accent)}.foot{margin-top:1rem;color:var(--weh-muted);font-size:.75rem}.error{color:var(--weh-danger)}
    @media(prefers-color-scheme:dark){:host{--weh-bg:#111827;--weh-fg:#f3f4f6;--weh-muted:#b5becd;--weh-border:#374151;--weh-accent:#7db2ff;--weh-danger:#ff8b8b}}
  `;

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch { return null; }
  }

  function contactHref(scheme, value) {
    const clean = String(value ?? '').replace(/[^+\d*#]/g, '');
    return clean ? `${scheme}:${clean}` : null;
  }

  function element(name, options = {}) {
    const node = document.createElement(name);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = String(options.text);
    return node;
  }

  class WorldEmergencyHotlines extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this.manifest = null;
      this.resolver = null;
      this.country = null;
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return;
      this.renderShell();
      this.loadManifest();
    }

    get apiBase() {
      const requested = this.getAttribute('api-base');
      const base = requested ? new URL(requested, document.baseURI) : new URL('/api/v1/', scriptOrigin);
      if (!['http:', 'https:'].includes(base.protocol)) throw new Error('api-base must use HTTP or HTTPS');
      return base.href.endsWith('/') ? base.href : `${base.href}/`;
    }

    get maxResults() {
      const value = Number.parseInt(this.getAttribute('max-results') || '6', 10);
      return Number.isFinite(value) ? Math.min(12, Math.max(1, value)) : 6;
    }

    renderShell() {
      const style = element('style', { text: css });
      const shell = element('section', { className: 'shell' });
      shell.setAttribute('aria-labelledby', 'weh-title');
      const title = element('h2', { text: this.getAttribute('heading') || 'Find crisis support' }); title.id = 'weh-title';
      const intro = element('p', { className: 'intro', text: 'Choose a country, need, and preferred contact channel. Selections stay in this browser.' });
      const form = element('form', { className: 'grid' }); form.noValidate = false;

      const countryLabel = element('label', { text: 'Country' });
      const country = element('select'); country.id = 'weh-country'; country.required = true; countryLabel.htmlFor = country.id;
      country.append(new Option('Loading countries…', ''));
      countryLabel.append(country);

      const row = element('div', { className: 'row' });
      const localityLabel = element('label', { text: 'City, county, state, or locality (optional)' });
      const locality = element('input'); locality.id = 'weh-locality'; locality.autocomplete = 'address-level2'; locality.maxLength = 100; locality.placeholder = 'Use the wording in the service area'; localityLabel.htmlFor = locality.id; localityLabel.append(locality);
      const needLabel = element('label', { text: 'Type of help' });
      const need = element('select'); need.id = 'weh-need'; need.required = true; needLabel.htmlFor = need.id; need.append(new Option('Select a country first', '')); needLabel.append(need);
      row.append(localityLabel, needLabel);

      const fieldset = element('fieldset'); const legend = element('legend', { text: 'Preferred channel' }); const channels = element('div', { className: 'channels' });
      for (const [value, label] of [['any', 'Any'], ['phone', 'Phone'], ['text', 'Text'], ['chat', 'Online chat']]) {
        const lab = element('label'); const radio = element('input'); radio.type = 'radio'; radio.name = 'weh-channel'; radio.value = value; radio.checked = value === (this.getAttribute('channel') || 'any'); lab.append(radio, document.createTextNode(label)); channels.append(lab);
      }
      fieldset.append(legend, channels);
      const submit = element('button', { text: 'Find recorded options' }); submit.type = 'submit';
      form.append(countryLabel, row, fieldset, submit);

      const status = element('div', { className: 'status' }); status.id = 'weh-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const output = element('div'); output.id = 'weh-output'; output.hidden = true; output.tabIndex = -1;
      const foot = element('p', { className: 'foot', text: 'Recorded listings are not live availability checks, medical advice, or guarantees of eligibility. In immediate danger, use the emergency number shown or local emergency services.' });
      shell.append(title, intro, form, status, output, foot); this.shadowRoot.append(style, shell);
      this.ui = { form, country, locality, need, status, output, submit };
      country.addEventListener('change', () => this.loadCountry());
      form.addEventListener('submit', (event) => { event.preventDefault(); if (form.reportValidity()) this.resolve(); });
    }

    async loadManifest() {
      this.setStatus('Loading country list…');
      try {
        const response = await fetch(new URL('manifest.json', this.apiBase));
        if (!response.ok) throw new Error(`API manifest returned ${response.status}`);
        this.manifest = await response.json();
        this.ui.country.replaceChildren(new Option('Select a country', ''));
        for (const country of this.manifest.countries || []) this.ui.country.append(new Option(country.name, country.alpha2.toLowerCase()));
        const initial = (this.getAttribute('country') || '').toLowerCase();
        if (initial && [...this.ui.country.options].some((option) => option.value === initial)) {
          this.ui.country.value = initial; await this.loadCountry();
        }
        this.setStatus('Country list loaded.');
      } catch (error) { this.showError(error); }
    }

    async loadCountry() {
      const code = this.ui.country.value;
      this.country = null; this.ui.need.replaceChildren(new Option(code ? 'Loading options…' : 'Select a country first', ''));
      if (!code) return;
      this.setStatus('Loading the selected country record…');
      try {
        const response = await fetch(new URL(`countries/${encodeURIComponent(code)}.json`, this.apiBase));
        if (!response.ok) throw new Error(`Country data returned ${response.status}`);
        this.country = await response.json();
        const categories = [...new Set((this.country.hotlines || []).filter((h) => h.verification_status !== 'deprecated').map((h) => h.category))].sort((a, b) => (CATEGORY_LABELS[a] || a).localeCompare(CATEGORY_LABELS[b] || b));
        this.ui.need.replaceChildren(new Option('Select a need', ''));
        for (const category of categories) this.ui.need.append(new Option(CATEGORY_LABELS[category] || category.replace(/_/g, ' '), category));
        const preferred = this.getAttribute('category') || '';
        if (categories.includes(preferred)) this.ui.need.value = preferred;
        this.ui.locality.value = this.getAttribute('locality') || this.ui.locality.value;
        this.setStatus(`${this.country.country} options loaded.`);
      } catch (error) { this.showError(error); }
    }

    async resolve() {
      if (!this.country) return this.showError(new Error('Select a country and wait for its options to load.'));
      this.ui.submit.disabled = true; this.setStatus('Resolving recorded options…');
      try {
        if (!this.resolver) this.resolver = await import(new URL('resolver.js', this.apiBase).href);
        const channel = this.shadowRoot.querySelector('input[name="weh-channel"]:checked')?.value || 'any';
        const result = this.resolver.resolveGuidedHelp({ country: this.country, category: this.ui.need.value, channel, locality: this.ui.locality.value.trim() });
        this.renderResult(result);
        this.setStatus(`${result.results.length} recorded option${result.results.length === 1 ? '' : 's'} resolved.`);
        this.dispatchEvent(new CustomEvent('weh-results', { detail: { country: this.country.alpha2, scope: result.scope, fallback: result.fallback, resultIds: result.results.map((item) => item.id) } }));
      } catch (error) { this.showError(error); }
      finally { this.ui.submit.disabled = false; }
    }

    renderResult(result) {
      const output = this.ui.output; output.replaceChildren(); output.hidden = false;
      const emergency = (this.country.general_emergency || []).filter(Boolean);
      if (emergency.length) {
        const box = element('section', { className: 'emergency' }); box.append(element('h3', { text: `Emergency numbers recorded for ${this.country.country}` }));
        const actions = element('div', { className: 'actions' });
        for (const number of emergency) { const href = contactHref('tel', number); if (href) actions.append(this.actionLink(number, href)); }
        box.append(actions); output.append(box);
      }
      const notice = element('section', { className: `notice${result.fallback ? ' fallback' : ''}` });
      notice.append(element('strong', { text: `${result.fallback ? 'Fallback used' : 'Recorded match'} · ${result.scope} scope` }), element('p', { text: result.reason })); output.append(notice);
      const list = element('div', { className: 'results' });
      const records = result.results.slice(0, this.maxResults);
      if (!records.length) list.append(element('p', { text: 'No recorded service could be resolved for these selections.' }));
      for (const record of records) list.append(this.renderRecord(record));
      output.append(list); output.focus({ preventScroll: false });
    }

    renderRecord(record) {
      const card = element('article', { className: 'card' }); card.dataset.recordId = record.id;
      card.append(element('h3', { text: record.name }));
      if (record.organization && record.organization !== record.name) card.append(element('p', { className: 'meta', text: record.organization }));
      card.append(element('p', { className: 'meta', text: `Recorded service area: ${record.geography || this.country.country}` }));
      const actions = element('div', { className: 'actions' });
      for (const phone of [...(record.voice_numbers || []), ...(record.short_codes || [])].slice(0, 2)) { const href = contactHref('tel', phone); if (href) actions.append(this.actionLink(phone, href)); }
      for (const text of [...(record.sms_numbers || []), ...(record.text_numbers || [])].slice(0, 2)) { const href = contactHref('sms', text); if (href) actions.append(this.actionLink(`Text ${text}`, href)); }
      const chat = safeHttpUrl(record.chat_url); if (chat) actions.append(this.actionLink('Online chat', chat, true));
      if (actions.childElementCount) card.append(actions);
      const evidence = element('div', { className: 'evidence' }); evidence.append(element('span', { text: String(record.verification_status || 'unknown').replace(/_/g, ' ') }), element('span', { text: `ID ${record.id}` }));
      if (record.last_verified) evidence.append(element('span', { text: `Source checked ${record.last_verified}` }));
      const source = safeHttpUrl(record.website) || safeHttpUrl(record.sources?.[0]); if (source) evidence.append(this.actionLink('Source', source, true));
      card.append(evidence); return card;
    }

    actionLink(label, href, external = false) {
      const link = element('a', { className: 'action', text: label }); link.href = href;
      if (external) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      return link;
    }

    setStatus(message) { this.ui.status.className = 'status'; this.ui.status.textContent = message; }
    showError(error) { this.ui.status.className = 'status error'; this.ui.status.textContent = error instanceof Error ? error.message : 'The widget could not load recorded options.'; }
  }

  if (!customElements.get(TAG)) customElements.define(TAG, WorldEmergencyHotlines);
})();
