import type {RetentionPolicy} from './topic-schema';

const deleteAge:RetentionPolicy<'delete'>={maxRetentionMinutes:60};
const deleteCount:RetentionPolicy<'delete'>={maxRetentionMessages:50};
const compactCount:RetentionPolicy<'compact'>={maxRetentionMessagesPerKey:4};
const compactDelete:RetentionPolicy<'compact,delete'>={maxRetentionMinutes:120,maxRetentionMessagesPerKey:10};
void [deleteAge,deleteCount,compactCount,compactDelete];
// @ts-expect-error global topic counts are delete-only
const wrongGlobal:RetentionPolicy<'compact'>={maxRetentionMessages:4};
// @ts-expect-error per-key caps are compact-only
const wrongPerKey:RetentionPolicy<'delete'>={maxRetentionMessagesPerKey:4};
// @ts-expect-error count branches are mutually exclusive
const both:RetentionPolicy<'delete'>={maxRetentionMessages:4,maxRetentionMessagesPerKey:2};
void [wrongGlobal,wrongPerKey,both];
