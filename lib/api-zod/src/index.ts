export * from "./generated/api";
export * from "./generated/types";
// withdrawEventNpcSignup has BOTH path params (zod const in generated/api) and
// query params (TS type in generated/types) named WithdrawEventNpcSignupParams,
// which makes the star re-exports ambiguous. Re-export explicitly: the zod
// const as the value, the query-params shape as the type.
export { WithdrawEventNpcSignupParams } from "./generated/api";
export type { WithdrawEventNpcSignupParams as WithdrawEventNpcSignupQueryParamsType } from "./generated/types";
// Same ambiguity for request bodies that orval emits both as a zod const
// (generated/api) and a TS type (generated/types).
export { SetEventTicketAttendanceBody } from "./generated/api";
export type { SetEventTicketAttendanceBody as SetEventTicketAttendanceBodyType } from "./generated/types";
export { PurchaseEventTicketBody } from "./generated/api";
export type { PurchaseEventTicketBody as PurchaseEventTicketBodyType } from "./generated/types";
export { SetEventCheckinStaffBody } from "./generated/api";
export type { SetEventCheckinStaffBody as SetEventCheckinStaffBodyType } from "./generated/types";
export { MarkNotificationsReadBody } from "./generated/api";
export type { MarkNotificationsReadBody as MarkNotificationsReadBodyType } from "./generated/types";
export { CallTraumaTeamBody } from "./generated/api";
export type { CallTraumaTeamBody as CallTraumaTeamBodyType } from "./generated/types";
export { SetTextScalePreferenceBody } from "./generated/api";
export type { SetTextScalePreferenceBody as SetTextScalePreferenceBodyType } from "./generated/types";
export { SetCharacterKindBody } from "./generated/api";
export type { SetCharacterKindBody as SetCharacterKindBodyType } from "./generated/types";
export { UpdateCharacterTagsBody } from "./generated/api";
export type { UpdateCharacterTagsBody as UpdateCharacterTagsBodyType } from "./generated/types";
export { AdminWalletMirrorPushBody } from "./generated/api";
export type { AdminWalletMirrorPushBody as AdminWalletMirrorPushBodyType } from "./generated/types";
export { GetEventParams } from "./generated/api";
export type { GetEventParams as GetEventQueryParamsType } from "./generated/types";
