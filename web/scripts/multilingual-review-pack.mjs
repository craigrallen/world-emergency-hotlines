import ts from 'typescript';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { containsAffirmativeTranslationReviewClaim } from './locale-qualification.mjs';

export const PACK_SCHEMA = 'internal-multilingual-ui-review-pack/v1';
export const CLASSIFICATIONS = Object.freeze(['safety_facing', 'legal_sensitive', 'ordinary_ui']);
export const DECISION_PLACEHOLDER = Object.freeze({
  status: 'pending_not_reviewed',
  reviewerIdentity: null,
  reviewedAt: null,
  evidenceAt: null,
  notes: null,
});

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function literalText(node, label) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  throw new Error(`${label} must use a static string literal`);
}

function propertyName(node, label) {
  if (ts.isIdentifier(node)) return node.text;
  return literalText(node, label);
}

function objectStrings(node, label) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`${label} must be an object literal`);
  const result = {};
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error(`${label} contains a non-static property`);
    const key = propertyName(property.name, `${label} key`);
    if (own(result, key)) throw new Error(`${label} contains duplicate key ${key}`);
    result[key] = literalText(property.initializer, `${label}.${key}`);
  }
  return result;
}

export function parseCanonicalDictionaries(source) {
  const file = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (file.parseDiagnostics.length) {
    throw new Error(`i18n.ts TypeScript parse diagnostics: ${file.parseDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ')}`);
  }
  const declarations = new Map();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  const localeNode = declarations.get('LOCALES');
  const localeArray = ts.isAsExpression(localeNode) ? localeNode.expression : localeNode;
  if (!localeArray || !ts.isArrayLiteralExpression(localeArray)) throw new Error('LOCALES must be a static array');
  const locales = localeArray.elements.map((node) => literalText(node, 'LOCALES entry'));
  const english = objectStrings(declarations.get('EN'), 'EN');
  const dictionaryNode = declarations.get('DICTIONARIES');
  if (!dictionaryNode || !ts.isObjectLiteralExpression(dictionaryNode)) throw new Error('DICTIONARIES must be a static object');
  const overrides = {};
  for (const property of dictionaryNode.properties) {
    if (!ts.isPropertyAssignment(property)) throw new Error('DICTIONARIES contains a non-static property');
    const locale = propertyName(property.name, 'DICTIONARIES locale');
    if (locale === 'en') {
      if (!ts.isIdentifier(property.initializer) || property.initializer.text !== 'EN') throw new Error('English dictionary must reference EN');
      overrides.en = english;
      continue;
    }
    const call = property.initializer;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'translateSet' || call.arguments.length !== 1 || !ts.isIdentifier(call.arguments[0])) {
      throw new Error(`Dictionary ${locale} must be a static translateSet override`);
    }
    overrides[locale] = objectStrings(declarations.get(call.arguments[0].text), call.arguments[0].text);
  }
  if (JSON.stringify(locales) !== JSON.stringify(Object.keys(overrides))) throw new Error('LOCALES and DICTIONARIES order/content differ');
  for (const [locale, values] of Object.entries(overrides)) {
    for (const key of Object.keys(values)) if (!own(english, key)) throw new Error(`${locale} contains unknown key ${key}`);
  }
  return { locales, english, overrides };
}

// Independent parity oracle: execute TypeScript's emitted JavaScript instead of
// interpreting the source AST with the extraction code above.
export function evaluateCanonicalRuntime(source, localeStatusManifest = {}) {
  const sourceDiagnostics = ts.transpileModule(source, {
    fileName: 'i18n.ts', reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).diagnostics ?? [];
  if (sourceDiagnostics.length) throw new Error(`i18n.ts TypeScript transpile diagnostics: ${sourceDiagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ')}`);
  const sourceWithManifestStub = source.replace(
    /import localeStatusManifest from ['"]\.\/locale-status\.json['"] with \{ type: ['"]json['"] \};/,
    '',
  );
  if (sourceWithManifestStub === source) throw new Error('i18n.ts runtime oracle could not isolate the locale-status JSON import');
  // Wrap every actual translateSet call. The wrapper records the input object's
  // own keys and the returned dictionary identity, without knowing locale or
  // internal dictionary variable names.
  const instrumented = sourceWithManifestStub.replace(
    /\btranslateSet\s*\(([^()]+)\)/g,
    '__captureTranslateSet__(translateSet, $1)',
  );
  if (instrumented === sourceWithManifestStub) throw new Error('i18n.ts runtime oracle could not instrument translateSet calls');
  const oracleSource = `const localeStatusManifest = globalThis.__LOCALE_STATUS_MANIFEST__;\nconst __runtimeCalls = [];\nconst __captureTranslateSet__ = (fn, overrides) => { const dictionary = fn(overrides); __runtimeCalls.push({ dictionary, keys: Object.keys(overrides) }); return dictionary; };\n${instrumented}\nexport const __RUNTIME_CALLS__ = __runtimeCalls;\n`;
  const emitted = ts.transpileModule(oracleSource, {
    fileName: 'i18n.ts',
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const diagnostics = emitted.diagnostics ?? [];
  if (diagnostics.length) {
    throw new Error(`i18n.ts TypeScript transpile diagnostics: ${diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('; ')}`);
  }
  const module = { exports: {} };
  vm.runInNewContext(emitted.outputText, { module, exports: module.exports, __LOCALE_STATUS_MANIFEST__: localeStatusManifest, Set }, {
    filename: 'i18n.runtime.cjs', timeout: 1_000,
  });
  const runtime = module.exports;
  if (!Array.isArray(runtime.LOCALES) || !runtime.DICTIONARIES || typeof runtime.DICTIONARIES !== 'object' || !Array.isArray(runtime.__RUNTIME_CALLS__)) {
    throw new Error('i18n.ts runtime oracle expected exported LOCALES, DICTIONARIES, and translateSet instrumentation');
  }
  const overrideKeys = {};
  for (const locale of runtime.LOCALES) {
    const dictionary = runtime.DICTIONARIES[locale];
    if (!dictionary || typeof dictionary !== 'object') throw new Error(`i18n.ts runtime oracle missing dictionary for ${locale}`);
    const calls = runtime.__RUNTIME_CALLS__.filter((call) => call.dictionary === dictionary);
    if (locale === runtime.LOCALES[0]) overrideKeys[locale] = Object.keys(dictionary);
    else if (calls.length === 1) overrideKeys[locale] = calls[0].keys;
    else throw new Error(`i18n.ts runtime oracle expected exactly one translateSet call for ${locale}`);
  }
  if (Object.keys(runtime.DICTIONARIES).length !== runtime.LOCALES.length) throw new Error('i18n.ts runtime oracle locale/dictionary inventory mismatch');
  runtime.__RUNTIME_OVERRIDE_KEYS__ = overrideKeys;
  return runtime;
}

function validateManifest(manifest) {
  const topLevelKeys = ['schemaVersion', 'sourceLocale', 'fallbackLocale', 'translatedScope', 'canonicalProviderDataTranslated', 'localVerificationRequired', 'locales'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).length !== topLevelKeys.length
    || topLevelKeys.some((key) => !own(manifest, key))
    || Object.keys(manifest).some((key) => !topLevelKeys.includes(key))) {
    throw new Error(`manifest must contain exactly ${topLevelKeys.join(', ')}`);
  }
  if (manifest.schemaVersion !== 1) throw new Error('manifest schemaVersion must be exactly 1');
  if (manifest.sourceLocale !== 'en' || manifest.fallbackLocale !== 'en') throw new Error('manifest must keep English as source and fallback');
  if (manifest.translatedScope !== 'selected_static_ui_keys_only') throw new Error('manifest translatedScope must be selected_static_ui_keys_only');
  if (manifest.canonicalProviderDataTranslated !== false) throw new Error('manifest must exclude canonical provider data translation');
  if (manifest.localVerificationRequired !== true) throw new Error('manifest must require local verification');
  if (!Array.isArray(manifest.locales) || manifest.locales.length === 0) throw new Error('manifest locales must be a non-empty array');
  const allowed = new Set(['locale', 'role', 'reviewStatus']);
  for (const [index, locale] of manifest.locales.entries()) {
    if (!locale || typeof locale !== 'object' || Array.isArray(locale) || Object.keys(locale).some((key) => !allowed.has(key)) || Object.keys(locale).length !== 3) {
      throw new Error(`manifest locale ${index} must contain exactly locale, role, and reviewStatus`);
    }
    const english = locale.locale === 'en';
    if (english && (index !== 0 || locale.role !== 'source_master' || locale.reviewStatus !== 'source_master_not_formally_certified')) {
      throw new Error('manifest English locale must be the first exact source master');
    }
    if (!english && (locale.role !== 'ui_translation' || locale.reviewStatus !== 'not_independently_human_reviewed')) {
      throw new Error(`manifest non-English locale ${locale.locale} must have the exact unreviewed UI translation contract`);
    }
  }
  if (manifest.locales.filter(({ locale }) => locale === 'en').length !== 1) throw new Error('manifest must contain exactly one English locale');
  if (new Set(manifest.locales.map(({ locale }) => locale)).size !== manifest.locales.length) throw new Error('manifest locale identifiers must be unique');
}

export function generateReviewPack({ i18nSource, manifest, classificationPolicy }) {
  const parsed = parseCanonicalDictionaries(i18nSource);
  validateManifest(manifest);
  const manifestLocales = manifest.locales.map(({ locale }) => locale);
  if (JSON.stringify(parsed.locales) !== JSON.stringify(manifestLocales)) throw new Error('manifest locales must exactly match canonical locale order');
  const keys = Object.keys(parsed.english);
  const policyKeys = ['schema', 'canonicalKeySha256', 'canonicalKeyValueSha256', 'runtimeLocaleKeyValueStateSha256', 'safetyFacingKeys', 'legalSensitiveKeys', 'ordinaryUiKeys'];
  if (!classificationPolicy || typeof classificationPolicy !== 'object' || Array.isArray(classificationPolicy)
    || JSON.stringify(Object.keys(classificationPolicy)) !== JSON.stringify(policyKeys)) throw new Error('classification policy must be closed and ordered');
  if (classificationPolicy.schema !== 'static-ui-safety-classification/v1') throw new Error('unsupported classification policy');
  const keyDigest = createHash('sha256').update(`${keys.join('\n')}\n`).digest('hex');
  if (classificationPolicy.canonicalKeySha256 !== keyDigest) throw new Error('classification policy does not cover the exact canonical key inventory');
  // JSON encodes the ordered tuple array without delimiter ambiguity and keeps
  // value-only source changes coupled to an explicit policy update.
  const sourceDigest = createHash('sha256').update(JSON.stringify(keys.map((key) => [key, parsed.english[key]]))).digest('hex');
  if (classificationPolicy.canonicalKeyValueSha256 !== sourceDigest) throw new Error('classification policy does not cover the exact canonical English key/value inventory');
  const runtime = evaluateCanonicalRuntime(i18nSource, manifest);
  if (JSON.stringify(Array.from(runtime.LOCALES)) !== JSON.stringify(parsed.locales)) throw new Error('runtime locale inventory differs from canonical source');
  const runtimeInventory = parsed.locales.flatMap((locale) => keys.map((key) => {
    const overridden = locale === 'en' || Array.from(runtime.__RUNTIME_OVERRIDE_KEYS__[locale]).includes(key);
    return [locale, key, runtime.DICTIONARIES[locale][key], locale === 'en' ? 'source_master' : overridden ? 'locale_override' : 'english_fallback'];
  }));
  const runtimeDigest = createHash('sha256').update(JSON.stringify(runtimeInventory)).digest('hex');
  if (classificationPolicy.runtimeLocaleKeyValueStateSha256 !== runtimeDigest) throw new Error('classification policy does not cover the exact ordered runtime locale/key/effective-value/override-state inventory');
  const lists = {
    safety_facing: classificationPolicy.safetyFacingKeys,
    legal_sensitive: classificationPolicy.legalSensitiveKeys,
    ordinary_ui: classificationPolicy.ordinaryUiKeys,
  };
  const seen = new Map();
  for (const [classification, list] of Object.entries(lists)) {
    if (!Array.isArray(list) || new Set(list).size !== list.length) throw new Error('classification policy lists must be unique arrays');
    for (const key of list) {
      if (!own(parsed.english, key)) throw new Error(`classification policy contains unknown key ${key}`);
      if (seen.has(key)) throw new Error(`classification policy overlaps at ${key}`);
      seen.set(key, classification);
    }
  }
  const missing = keys.filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`classification policy is missing canonical key ${missing[0]}`);
  const entries = keys.map((key) => ({
    key,
    classification: seen.get(key),
    sourceEnglish: parsed.english[key],
    locales: parsed.locales.map((locale, index) => {
      const hasOverride = locale === 'en' || own(parsed.overrides[locale], key);
      return {
        locale,
        value: hasOverride ? parsed.overrides[locale][key] : parsed.english[key],
        valueState: locale === 'en' ? 'source_master' : hasOverride ? 'locale_override' : 'english_fallback',
        manifestReviewStatus: manifest.locales[index].reviewStatus,
        reviewerDecision: { ...DECISION_PLACEHOLDER },
      };
    }),
  }));
  return {
    schema: PACK_SCHEMA,
    internalOnly: true,
    authoritative: false,
    qualificationEffect: false,
    scope: 'finite_static_ui_strings_only',
    sourceLocale: 'en',
    fallbackLocale: 'en',
    canonicalProviderDataIncluded: false,
    valueSource: 'static_ui_runtime_dictionaries_only',
    excludedSourceClasses: ['canonical_provider_data', 'hotline_records', 'provider_contacts', 'provider_evidence'],
    localeCount: parsed.locales.length,
    keyCount: keys.length,
    locales: parsed.locales,
    entries,
  };
}

export const encodePack = (pack) => `${JSON.stringify(pack, null, 2)}\n`;

export function generateReviewPackSchema({ keys, locales }) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((key) => typeof key !== 'string' || key.length === 0) || new Set(keys).size !== keys.length) {
    throw new Error('schema keys must be a non-empty unique string array');
  }
  if (!Array.isArray(locales) || locales[0] !== 'en' || locales.length === 0 || locales.some((locale) => typeof locale !== 'string' || locale.length === 0) || new Set(locales).size !== locales.length) {
    throw new Error('schema locales must be a unique string array beginning with en');
  }
  const translatedCell = (locale) => ({
    $ref: '#/$defs/translatedCell', type: 'object', properties: { locale: { const: locale } },
  });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://hotlines.world/internal/contracts/multilingual-ui-review-pack/v1',
    $defs: {
      decision: { type: 'object', additionalProperties: false, required: ['status', 'reviewerIdentity', 'reviewedAt', 'evidenceAt', 'notes'], properties: { status: { const: 'pending_not_reviewed' }, reviewerIdentity: { type: 'null' }, reviewedAt: { type: 'null' }, evidenceAt: { type: 'null' }, notes: { type: 'null' } } },
      cell: { type: 'object', additionalProperties: false, required: ['locale', 'value', 'valueState', 'manifestReviewStatus', 'reviewerDecision'], properties: { locale: { type: 'string' }, value: { type: 'string' }, valueState: { enum: ['source_master', 'locale_override', 'english_fallback'] }, manifestReviewStatus: { enum: ['source_master_not_formally_certified', 'not_independently_human_reviewed'] }, reviewerDecision: { $ref: '#/$defs/decision' } } },
      sourceCell: { $ref: '#/$defs/cell', type: 'object', properties: { locale: { const: 'en' }, valueState: { const: 'source_master' }, manifestReviewStatus: { const: 'source_master_not_formally_certified' } } },
      translatedCell: { $ref: '#/$defs/cell', type: 'object', properties: { valueState: { enum: ['locale_override', 'english_fallback'] }, manifestReviewStatus: { const: 'not_independently_human_reviewed' } } },
      entry: {
        type: 'object', additionalProperties: false, required: ['key', 'classification', 'sourceEnglish', 'locales'],
        properties: {
          key: { type: 'string', minLength: 1 }, classification: { enum: CLASSIFICATIONS }, sourceEnglish: { type: 'string' },
          locales: { type: 'array', minItems: locales.length, maxItems: locales.length, items: false, prefixItems: [{ $ref: '#/$defs/sourceCell' }, ...locales.slice(1).map(translatedCell)] },
        },
      },
    },
    type: 'object',
    additionalProperties: false,
    required: ['schema', 'internalOnly', 'authoritative', 'qualificationEffect', 'scope', 'sourceLocale', 'fallbackLocale', 'canonicalProviderDataIncluded', 'valueSource', 'excludedSourceClasses', 'localeCount', 'keyCount', 'locales', 'entries'],
    properties: {
      schema: { const: PACK_SCHEMA }, internalOnly: { const: true }, authoritative: { const: false }, qualificationEffect: { const: false },
      scope: { const: 'finite_static_ui_strings_only' }, sourceLocale: { const: 'en' }, fallbackLocale: { const: 'en' }, canonicalProviderDataIncluded: { const: false },
      valueSource: { const: 'static_ui_runtime_dictionaries_only' }, excludedSourceClasses: { const: ['canonical_provider_data', 'hotline_records', 'provider_contacts', 'provider_evidence'] },
      localeCount: { const: locales.length }, keyCount: { const: keys.length }, locales: { const: locales },
      entries: { type: 'array', minItems: keys.length, maxItems: keys.length, items: false, prefixItems: keys.map((key) => ({ $ref: '#/$defs/entry', type: 'object', properties: { key: { const: key } } })) },
    },
  };
}

export function generateCanonicalReviewPackSchema(i18nSource) {
  const { locales, english } = parseCanonicalDictionaries(i18nSource);
  return generateReviewPackSchema({ keys: Object.keys(english), locales });
}

export const encodeSchema = (schema) => `${JSON.stringify(schema, null, 2)}\n`;

export function reviewPackSafetyErrors(pack) {
  const values = [];
  const collect = (value) => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(pack);
  const errors = [];
  const normalized = values.map((value) => value.normalize('NFKC'));
  const scan = (label, pattern) => { if (normalized.some((value) => pattern.test(value))) errors.push(label); };
  if (normalized.some(containsAffirmativeTranslationReviewClaim)) errors.push('affirmative human-review claim');
  scan('email leakage', /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/iu);
  scan('URI leakage', /(?:https?|ftp|mailto|tel|sms|data|javascript)\s*[:：]/iu);
  // These are the complete, explicit benign numeric contexts. Everything else
  // fails closed when it contains a standalone 3–6 digit decimal run.
  const phoneCandidates = normalized.map((value) => value
    .replace(/\b\p{Nd}{4}-\p{Nd}{1,2}-\p{Nd}{1,2}\b/gu, '')
    .replace(/\bcopyright\s*\p{Nd}{4}\b/giu, '')
    .replace(/\b(?:version|v)\s*\p{Nd}+(?:\.\p{Nd}+)*\b/giu, '')
    .replace(/(?<!\p{L})(?:showing|count|total)\s*\p{Nd}+(?:\s+results?)?(?!\p{L})/giu, '')
    .replace(/(?<![\p{L}\p{N}])\p{Nd}+\s+results?(?!\p{L})/giu, ''));
  if (phoneCandidates.some((value) => /(?:\+\s*)?\p{Nd}(?:[\p{Nd}\s().-]*\p{Nd}){6,}|(?<!\p{Nd})\p{Nd}{3,6}(?!\p{Nd})/u.test(value))) errors.push('phone-shaped leakage');
  scan('provider-identifying data', /(?:provider|service|organisation|organization)\s*(?:id|identifier|record)\s*[:#]/iu);
  if (pack.canonicalProviderDataIncluded !== false) errors.push('canonical provider data inclusion');
  if (pack.valueSource !== 'static_ui_runtime_dictionaries_only' || JSON.stringify(pack.excludedSourceClasses) !== JSON.stringify(['canonical_provider_data', 'hotline_records', 'provider_contacts', 'provider_evidence'])) errors.push('source provenance contract');
  if (pack.qualificationEffect !== false || pack.authoritative !== false) errors.push('qualification or authority effect');
  return errors;
}
