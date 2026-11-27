-- Corrections without review (docs/DESIGN.md#corrections): an observation set applies as soon as
-- it's saved, and disruptions are gone (SkyTrain alerts are shown as text instead).
--
-- Sets never confirmed never applied: they're deleted rather than applied now. Preview dispatch
-- versions go with the review step.

delete from observation_sets where state <> 'confirmed';
alter table observation_sets
  drop column state,
  drop column reviewed_by,
  drop column reviewed_at;

drop table disruptions;

delete from dispatch_versions where kind = 'preview';
alter table dispatch_versions
  drop column kind,
  drop column preview_of;
