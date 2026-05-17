/**
 * Golden-set of (a, b) → expected LLM verdict pairs used by the `rothunter:eval`
 * script to measure confirmer quality against a known ground truth.
 *
 * Pairs reference symbols by `<file>::<interfaceName>`. The eval harness parses
 * the workspace, resolves these strings to SymbolRecord pairs, runs the LLM
 * confirmer, and tabulates accuracy.
 *
 * DO NOT IMPORT FROM PRODUCTION CODE.
 */

export interface GoldenPair {
  /** Short human label for output tables. */
  id: string;
  /** `<fixture-file>::<interfaceName>` */
  a: string;
  /** `<fixture-file>::<interfaceName>` */
  b: string;
  /** What the LLM should say. */
  expected: 'same' | 'different';
  /**
   * Lower bound on |confidence| for a correct verdict. The confirmer either
   * achieves at least `min_confidence` agreeing with `expected`, or it counts
   * as a miss even when the boolean is right.
   */
  min_confidence: number;
  /** Why this is the right answer — for humans reading the eval report. */
  rationale: string;
}

export const GOLDEN_PAIRS: GoldenPair[] = [
  // -------------------------------------------------------------------------
  // SAME-CONCEPT cases — confirmer must say YES
  // -------------------------------------------------------------------------

  {
    id: 'same/identical-by-name',
    a: 'dups-a.ts::UserProfile',
    b: 'dups-b.ts::UserProfile',
    expected: 'same',
    min_confidence: 0.85,
    rationale: 'Same name, identical fields — uncontroversial duplicate.',
  },
  {
    id: 'same/synonym-rename',
    a: 'dups-a.ts::OrderRecord',
    b: 'dups-b.ts::InvoiceDocument',
    expected: 'same',
    min_confidence: 0.7,
    rationale: '5 fields, identical types, names map 1:1 (orderId↔invoiceNumber, customerEmail↔vendorEmail, ...).',
  },
  {
    id: 'same/method-bearing',
    a: 'edge-cases-a.ts::T1_Runnable',
    b: 'edge-cases-b.ts::T1_Worker',
    expected: 'same',
    min_confidence: 0.85,
    rationale: 'Identical method signature `run(input, options?) => Promise<string>` plus same prop layout.',
  },
  {
    id: 'same/generics',
    a: 'edge-cases-a.ts::T2_Wrapper',
    b: 'edge-cases-b.ts::T2_Envelope',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Same nested generic shape Promise<{items:Array<{id, tags:ReadonlyArray<string>}>}> + Map<string,number>.',
  },
  {
    id: 'same/snake-camel-synonym',
    a: 'dups-a.ts::AccountSnakeCase',
    b: 'dups-b.ts::AccountCamelCase',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'snake_case ↔ camelCase pair, user_id/uid → id, mail/email synonym.',
  },
  {
    id: 'same/audit-event',
    a: 'edge-cases-a.ts::T5_AuditEvent',
    b: 'edge-cases-b.ts::T5_ChangeLog',
    expected: 'same',
    min_confidence: 0.7,
    rationale: '{actor, occurredAt:Date, action, reverted} vs {author, timestamp:Date, operation, rolledBack} — same domain.',
  },
  {
    id: 'same/chat-message',
    // These two live in real AME source, not fixtures — eval picks them up because the parser scans the whole workspace.
    a: 'src/interfaces/types.ts::IngestMessage',
    b: 'src/services/chunker.ts::ConversationMessage',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Both model a chat turn ({role, content}); divergence is naming only.',
  },

  // -------------------------------------------------------------------------
  // DIFFERENT-CONCEPT cases — confirmer must say NO
  // -------------------------------------------------------------------------

  {
    id: 'different/runpod-vs-document',
    a: 'scripts/runpod-template.ts::Template',
    b: 'dups-b.ts::Document',
    expected: 'different',
    min_confidence: 0.6,
    rationale: '{id, name} 2-field generic — RunPod API DTO vs test-fixture Document, unrelated domains.',
  },

  // -------------------------------------------------------------------------
  // Hard cases — added to push the eval from 8 to 12
  // -------------------------------------------------------------------------

  {
    id: 'different/color-vs-point',
    a: 'edge-cases-a.ts::G9_RGBColor',
    b: 'edge-cases-b.ts::G9_Point3D',
    expected: 'different',
    min_confidence: 0.7,
    rationale: 'Both {number×3} but colour channels vs 3D coordinates — type names carry the signal.',
  },
  {
    id: 'different/large-unrelated-domains',
    a: 'edge-cases-a.ts::G10_AudioMixerChannel',
    b: 'edge-cases-b.ts::G10_VideoEncoderProfile',
    expected: 'different',
    min_confidence: 0.7,
    rationale: '5 numeric fields each, audio mixer vs video encoder — large structural collision across distinct subsystems.',
  },
  {
    id: 'same/optional-vs-required',
    a: 'edge-cases-a.ts::G11_UserPrefsOptional',
    b: 'edge-cases-b.ts::G11_UserPrefsRequired',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Same field names + types; one variant has an optional modifier. Same concept.',
  },
  {
    id: 'same/method-different-name',
    a: 'edge-cases-a.ts::G12_RequestHandler',
    b: 'edge-cases-b.ts::G12_RouteHandler',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Both have id + pattern + a method (string)=>Promise<string>; handle vs serve is a rename.',
  },

  // -------------------------------------------------------------------------
  // Limit-pusher set — added to make sure 12/12 is not a brittle win.
  // -------------------------------------------------------------------------

  {
    id: 'same/nested-object',
    a: 'edge-cases-a.ts::G13_AccountWithSettingsA',
    b: 'edge-cases-b.ts::G13_AccountWithPreferencesB',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Both wrap user/email + a nested {theme, language, notifications} object; userId↔uid, settings↔preferences are renames.',
  },
  {
    id: 'same/acronym-mismatch',
    a: 'edge-cases-a.ts::G14_HttpRequestA',
    b: 'edge-cases-b.ts::G14_HttpRequestB',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'URL↔url, HTTPMethod↔httpMethod, bodyJSON↔bodyJson — same HTTP request, only acronym casing differs.',
  },
  {
    id: 'same/type-alias-vs-interface',
    a: 'edge-cases-a.ts::G15_RectangleA',
    b: 'edge-cases-b.ts::G15_RectangleB',
    expected: 'same',
    min_confidence: 0.8,
    rationale: 'Same shape declared as interface on one side and type-alias on the other.',
  },
  {
    id: 'same/date-vs-timestamp',
    a: 'edge-cases-a.ts::G16_DeploymentEventA',
    b: 'edge-cases-b.ts::G16_DeploymentEventB',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Same deployment event, occurredAt represented as Date vs epoch millis — same concept, different runtime encoding.',
  },

  // -------------------------------------------------------------------------
  // Cruelty set — last batch of edge cases pushing the model
  // -------------------------------------------------------------------------

  {
    id: 'same/recursive-self-reference',
    a: 'edge-cases-a.ts::G17_LinkedNodeA',
    b: 'edge-cases-b.ts::G17_LinkedItemB',
    expected: 'same',
    min_confidence: 0.8,
    rationale: 'Linked-list node: value + next pointer to self. Renames at both type-name and field level.',
  },
  {
    id: 'same/trojan-similar-name',
    a: 'edge-cases-a.ts::G18_OrderA',
    b: 'edge-cases-b.ts::G18_OrderHistoryEntryB',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'Identical shape across Order entity and OrderHistoryEntry. RotHunter surfaces this as a unification candidate — humans decide via the dashboard whether to keep the split or share a base type.',
  },
  {
    id: 'same/literal-vs-string-widening',
    a: 'edge-cases-a.ts::G19_TaskStatusA',
    b: 'edge-cases-b.ts::G19_TaskStateB',
    expected: 'same',
    min_confidence: 0.75,
    rationale: 'Same task state, B narrows `status` from `string` to a literal union — concept identical, just stricter.',
  },
  {
    id: 'same/generic-vs-specialized',
    a: 'edge-cases-a.ts::G20_ContainerA',
    b: 'edge-cases-b.ts::G20_StringListB',
    expected: 'same',
    min_confidence: 0.7,
    rationale: 'StringList is the T=string specialisation of Container<T> with no added behaviour. RotHunter surfaces this — humans decide whether to collapse StringList into Container<string>.',
  },
];
