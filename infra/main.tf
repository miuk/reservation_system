locals {
  backend_service_account_email  = google_service_account.backend.email
  frontend_service_account_email = google_service_account.frontend.email
  backend_url                    = google_cloud_run_v2_service.backend.uri
  firebase_auth_domain           = var.firebase_auth_domain != "" ? var.firebase_auth_domain : "${var.firebase_project_id}.firebaseapp.com"
  cloud_build_member             = "serviceAccount:${var.cloud_build_service_account_email}"
}

resource "google_project_service" "required" {
  for_each = toset([
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "iam.googleapis.com",
    "firestore.googleapis.com"
  ])

  project            = var.cloud_run_project_id
  service            = each.key
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "docker" {
  project       = var.cloud_run_project_id
  location      = var.region
  repository_id = var.artifact_repository_id
  format        = "DOCKER"
  description   = "Docker images for the reservation system Cloud Run services."

  depends_on = [google_project_service.required]
}

resource "google_service_account" "backend" {
  project      = var.cloud_run_project_id
  account_id   = var.backend_service_account_id
  display_name = "Reservation backend runtime"
}

resource "google_service_account" "frontend" {
  project      = var.cloud_run_project_id
  account_id   = var.frontend_service_account_id
  display_name = "Reservation frontend runtime"
}

resource "google_project_iam_member" "cloud_build_run_admin" {
  project = var.cloud_run_project_id
  role    = "roles/run.admin"
  member  = local.cloud_build_member
}

resource "google_service_account_iam_member" "cloud_build_act_as_backend" {
  service_account_id = google_service_account.backend.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.cloud_build_member
}

resource "google_service_account_iam_member" "cloud_build_act_as_frontend" {
  service_account_id = google_service_account.frontend.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.cloud_build_member
}

resource "google_project_iam_member" "backend_firestore_user" {
  project = var.firestore_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${local.backend_service_account_email}"
}

resource "google_cloud_run_v2_service" "backend" {
  project             = var.cloud_run_project_id
  name                = var.backend_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = local.backend_service_account_email

    containers {
      image = var.backend_initial_image

      ports {
        container_port = 8080
      }

      env {
        name  = "FIREBASE_PROJECT_ID"
        value = var.firebase_project_id
      }
      env {
        name  = "FIRESTORE_PROJECT_ID"
        value = var.firestore_project_id
      }
      env {
        name  = "FIRESTORE_DATABASE_ID"
        value = var.firestore_database_id
      }
      env {
        name  = "FRONTEND_ORIGIN"
        value = var.frontend_origin
      }
      env {
        name  = "ADMIN_EMAILS"
        value = var.admin_emails
      }
      env {
        name  = "RESOURCE_NAME"
        value = var.resource_name
      }
      env {
        name  = "RESERVATION_MONTHS_AHEAD"
        value = tostring(var.reservation_months_ahead)
      }
      env {
        name  = "MAX_SLOTS_PER_REQUEST"
        value = tostring(var.max_slots_per_request)
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image
    ]
  }

  depends_on = [
    google_project_service.required,
    google_project_iam_member.backend_firestore_user
  ]
}

resource "google_cloud_run_v2_service" "frontend" {
  project             = var.cloud_run_project_id
  name                = var.frontend_service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = local.frontend_service_account_email

    containers {
      image = var.frontend_initial_image

      ports {
        container_port = 8080
      }

      env {
        name  = "BACKEND_URL"
        value = local.backend_url
      }
      env {
        name  = "BACKEND_AUDIENCE"
        value = local.backend_url
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image
    ]
  }

  depends_on = [google_project_service.required]
}

resource "google_cloud_run_service_iam_member" "frontend_public" {
  project  = var.cloud_run_project_id
  location = google_cloud_run_v2_service.frontend.location
  service  = google_cloud_run_v2_service.frontend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_service_iam_member" "backend_invoker_frontend" {
  project  = var.cloud_run_project_id
  location = google_cloud_run_v2_service.backend.location
  service  = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.frontend_service_account_email}"
}

resource "google_cloudbuild_trigger" "backend" {
  project         = var.cloud_run_project_id
  location        = var.region
  name            = "${var.backend_service_name}-main"
  description     = "Deploy reservation backend on backend changes."
  filename        = "backend/cloudbuild.trigger.yaml"
  service_account = "projects/${var.cloud_run_project_id}/serviceAccounts/${var.cloud_build_service_account_email}"
  included_files  = ["backend/**"]

  github {
    owner = var.github_owner
    name  = var.github_repo

    push {
      branch = var.branch_pattern
    }
  }

  substitutions = {
    _REGION                   = var.region
    _SERVICE_NAME             = var.backend_service_name
    _FIREBASE_PROJECT_ID      = var.firebase_project_id
    _FIRESTORE_PROJECT_ID     = var.firestore_project_id
    _FIRESTORE_DATABASE_ID    = var.firestore_database_id
    _FRONTEND_ORIGIN          = var.frontend_origin
    _ADMIN_EMAILS             = var.admin_emails
    _RESOURCE_NAME            = var.resource_name
    _RESERVATION_MONTHS_AHEAD = tostring(var.reservation_months_ahead)
    _MAX_SLOTS_PER_REQUEST    = tostring(var.max_slots_per_request)
    _SERVICE_ACCOUNT          = local.backend_service_account_email
  }

  depends_on = [
    google_artifact_registry_repository.docker,
    google_project_iam_member.cloud_build_run_admin,
    google_service_account_iam_member.cloud_build_act_as_backend
  ]
}

resource "google_cloudbuild_trigger" "frontend" {
  project         = var.cloud_run_project_id
  location        = var.region
  name            = "${var.frontend_service_name}-main"
  description     = "Deploy reservation frontend on frontend changes."
  filename        = "frontend/cloudbuild.trigger.yaml"
  service_account = "projects/${var.cloud_run_project_id}/serviceAccounts/${var.cloud_build_service_account_email}"
  included_files  = ["frontend/**"]

  github {
    owner = var.github_owner
    name  = var.github_repo

    push {
      branch = var.branch_pattern
    }
  }

  substitutions = {
    _REGION                    = var.region
    _SERVICE_NAME              = var.frontend_service_name
    _BACKEND_URL               = local.backend_url
    _BACKEND_AUDIENCE          = local.backend_url
    _VITE_FIREBASE_API_KEY     = var.firebase_web_api_key
    _VITE_FIREBASE_AUTH_DOMAIN = local.firebase_auth_domain
    _VITE_FIREBASE_PROJECT_ID  = var.firebase_project_id
    _VITE_FIREBASE_APP_ID      = var.firebase_web_app_id
    _SERVICE_ACCOUNT           = local.frontend_service_account_email
  }

  depends_on = [
    google_artifact_registry_repository.docker,
    google_project_iam_member.cloud_build_run_admin,
    google_service_account_iam_member.cloud_build_act_as_frontend
  ]
}
