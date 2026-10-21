export {
  render, renderPlain, renderNoBody, proseWarnings, isPlainBody, resolveTheme, themeChoices,
  isThemeChoice,
  UnknownDestinationError,
  type RenderResult,
  type ThemeChoice,
} from './render';
export { showLineBreaks, hideLineBreaks, type LineBreakFact, type LineBreakFate } from './lineCharacters';
export {
  blockFieldOf,
  editFieldsOf,
  fieldWarnings,
  type EditFieldValue,
  isBlockField,
  lineFieldsOf,
  reviewFieldsComplaint,
  type ReviewField,
  type ReviewFieldKind,
  type ReviewFieldValue,
} from './reviewFields';
export { readPatch, type DeltaField, type PatchEdit } from './patch';
export {
  profiles,
  isKnownDestination,
  audienceFor,
  toolAudienceProbed,
  destinationLabelFor,
  type DestinationName,
  type DestinationProfile,
  type Mode,
  type PreviewFidelity,
  type SupportedThemes,
  type Theme,
  type ToolbarSupport,
  type ToolbarMark,
  TOOLBAR_MARKS,
  type ToolbarBlock,
  type ToolbarInsert,
  type CodeSpanMarks,
  ownAnswerFor,
  type AudienceFacts,
  type TargetIdentity,
  type TargetAnswer,
} from './profiles';
export { type Audience, type AudienceKind } from './audience';
// Jira's audience facts: the projectTypeKey vocabulary the CLI's config is keyed on, and the key
// parser that must agree with it. Sourcing them is the CLI's I/O; parsing is Jira's, in one place.
// Not `jiraToolProbed`: its consumer reads `toolAudienceProbed`, so nothing outside `core` names a
// destination to ask it.
export {
  jiraProjectKey,
  jiraTargetProjectKey,
  jiraSiteFor,
  jiraSiteKeyFor,
  jiraSiteKeysFor,
  jiraDestinationLabel,
  jiraProjectKeyOf,
  jiraSiteKey,
  isProjectType,
  JIRA_PROJECT_TYPES,
  type JiraProjectType,
  type JiraProjectSource,
  type JiraSite,
  type JiraAudienceFacts,
  type JiraAudienceAnswer,
} from './profiles/jira';

export {
  githubAudience,
  githubRepoKey,
  githubRepoKeyOf,
  isGitHubRepoVisibility,
  GITHUB_REPO_VISIBILITIES,
  type GitHubRepo,
  type GitHubRepoSource,
  type GitHubRepoVisibility,
  type GitHubAudienceFacts,
  type GitHubAudienceAnswer,
} from './profiles/github';

export {
  sortWarnings,
  hasBlockingWarning,
  isBlocking,
  isLengthRefusal,
  SUGGESTED_FIX_CODE,
  SUGGESTED_FIX_LABEL,
  WARNING_CODES,
  type Fix,
  type FixCode,
  type FixOffer,
  type Warning,
  type WarningCode,
  type WarningSpec,
  type Severity,
} from './warnings';

// The review surface's document API: markdown <-> TipTap document. Not `adfToProseMirror` /
// `proseMirrorToAdf`, the lower-level half of the same conversion.
export {
  toEditorDoc, editorDocFor, editorOptionsFor, fromEditorDoc, markdownFor, baselineFor, editorDocToAdf,
  type EditorDocOptions, type DocumentFacts, type PmNode,
} from './editor';
export { PM_KNOWN, pmMarkName } from './prosemirror';

// ADF structural knowledge, shared by the media fixer and the profile that checks these rules.
export {
  walk,
  collect,
  nodeTypes,
  markTypes,
  walkUntil,
  illegalMediaPlacements,
  INLINE_ONLY,
  ACCEPTS_BLOCKS,
  JSM_BLOCKQUOTE_ALLOWED,
  VISIBLE_ATOMS,
} from './adfSchema';

// Not `sanitizeAdfForJsm`: which destinations offer a fix is the profile's business, and the fix
// arrives as `RenderResult.suggestedFix`.
export type { AdfDocument, AdfNode, AdfMark } from './adf/types';
// What the window needs to draw the mention note, and nothing else. The scanner
// (`findMentionTokens`) and the counting helpers are reached through their module, and the patterns
// live on the profiles, so this barrel offers no destination-keyed table (see
// `surface/src/mentionPills.ts`).
export {
  mentionSummary,
  mentionNote,
  type MentionNote,
  type MentionSupport,
  type MentionTokenPattern,
} from './mentionTokens';
