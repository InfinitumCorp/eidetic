# Illustrative Open Policy Agent bundle for ei·det·ic™.
# The TypeScript decider in packages/policy is authoritative until this
# file is reviewed against authorizeSearch and OPA_URL is set.
# Do not send images, templates, or embeddings in input.

package eidetic.authorize

default allow := false

allow if {
  input.edition != "mil"
  input.purpose != null
  input.purpose.active == true
  input.purpose.edition == input.edition
  some basis in input.purpose.legalBases
  basis == input.legalBasis
  some dataset in input.purpose.datasetIds
  dataset == input.datasetId
  some role in input.purpose.allowedRoles
  role == input.actor.role
}
