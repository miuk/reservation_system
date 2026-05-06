output "backend_url" {
  description = "Backend Cloud Run service URL."
  value       = google_cloud_run_v2_service.backend.uri
}

output "frontend_url" {
  description = "Frontend Cloud Run service URL."
  value       = google_cloud_run_v2_service.frontend.uri
}

output "backend_service_account_email" {
  description = "Backend runtime service account email."
  value       = google_service_account.backend.email
}

output "frontend_service_account_email" {
  description = "Frontend runtime service account email."
  value       = google_service_account.frontend.email
}

output "artifact_repository" {
  description = "Artifact Registry repository path."
  value       = "${var.region}-docker.pkg.dev/${var.cloud_run_project_id}/${var.artifact_repository_id}"
}
