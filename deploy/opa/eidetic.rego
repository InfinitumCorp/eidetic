# Open Policy Agent bundle for ei·det·ic™.
# The embedded TypeScript decider in packages/policy is what CI runs.
# Load this file into OPA and set OPA_URL when you want the external engine.
# Do not put images, templates, or embeddings in input.
# Keycloak is the recommended production IdP. Verify the access token
# against the realm JWKS before mapping realm roles to ei·det·ic™ roles.

package eidetic.authorize

default allow := false

deny contains "MIL_NOT_ENABLED" if {
  input.edition == "mil"
  input.milEnabled == false
}

deny contains "MIL_NOT_IMPLEMENTED" if {
  input.edition == "mil"
  input.milEnabled == true
}

deny contains "PURPOSE_UNKNOWN" if {
  input.purpose == null
}

deny contains "FORBIDDEN" if {
  input.purpose != null
  some needle in ["social", "scrape", "osint", "mass", "surveil", "stalk", "clearance", "military", "weapon", "plate", "alpr"]
  contains(input.purpose.code, needle)
}

deny contains "PURPOSE_INACTIVE" if {
  input.purpose != null
  input.purpose.active == false
}

deny contains "EDITION_MISMATCH" if {
  input.purpose != null
  input.purpose.edition != input.edition
}

deny contains "ROLE_NOT_PERMITTED" if {
  input.purpose != null
  not input.actor.role in input.purpose.allowedRoles
}

deny contains "LEGAL_BASIS_REJECTED" if {
  input.purpose != null
  not input.legalBasis in input.purpose.legalBases
}

deny contains "DATASET_OUT_OF_SCOPE" if {
  input.purpose != null
  not input.datasetId in input.purpose.datasetIds
}

deny contains "SUBJECT_NOT_ENROLLED" if {
  input.consent.state == "not_enrolled"
}

deny contains "CONSENT_WITHDRAWN" if {
  input.consent.state == "withdrawn"
}

deny contains "CONSENT_EXPIRED" if {
  input.consent.state == "expired"
}

deny contains "CONSENT_REQUIRED" if {
  input.consent.state == "missing"
}

allow if {
  count(deny) == 0
  input.edition != "mil"
  input.purpose != null
  input.purpose.active == true
  input.purpose.edition == input.edition
}
