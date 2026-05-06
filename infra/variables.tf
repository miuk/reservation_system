variable "cloud_run_project_id" {
  description = "Google Cloud project ID that hosts Cloud Run, Cloud Build, and Artifact Registry."
  type        = string
}

variable "firebase_project_id" {
  description = "Firebase project ID used by Firebase Authentication."
  type        = string
}

variable "firestore_project_id" {
  description = "Google Cloud/Firebase project ID that hosts Firestore."
  type        = string
}

variable "region" {
  description = "Google Cloud region for Cloud Run, Cloud Build triggers, and Artifact Registry."
  type        = string
  default     = "asia-northeast1"
}

variable "artifact_repository_id" {
  description = "Artifact Registry Docker repository ID."
  type        = string
  default     = "cloud-run-source-deploy"
}

variable "backend_service_name" {
  description = "Cloud Run backend service name."
  type        = string
  default     = "reservation-backend"
}

variable "frontend_service_name" {
  description = "Cloud Run frontend service name."
  type        = string
  default     = "reservation-frontend"
}

variable "backend_service_account_id" {
  description = "Service account ID for backend Cloud Run runtime."
  type        = string
  default     = "backend-sa"
}

variable "frontend_service_account_id" {
  description = "Service account ID for frontend Cloud Run runtime."
  type        = string
  default     = "frontend-sa"
}

variable "cloud_build_service_account_email" {
  description = "Service account email used by Cloud Build triggers. For the default compute service account, use PROJECT_NUMBER-compute@developer.gserviceaccount.com."
  type        = string
}

variable "github_owner" {
  description = "GitHub repository owner for Cloud Build triggers."
  type        = string
}

variable "github_repo" {
  description = "GitHub repository name for Cloud Build triggers."
  type        = string
}

variable "branch_pattern" {
  description = "Branch regex for Cloud Build triggers."
  type        = string
  default     = "^main$"
}

variable "admin_emails" {
  description = "Comma-separated initial admin email list for backend."
  type        = string
}

variable "resource_name" {
  description = "Reservation target name shown in the UI."
  type        = string
  default     = "会議室"
}

variable "reservation_months_ahead" {
  description = "How many months ahead reservations can be created."
  type        = number
  default     = 6

  validation {
    condition     = var.reservation_months_ahead >= 1 && floor(var.reservation_months_ahead) == var.reservation_months_ahead
    error_message = "reservation_months_ahead must be a positive integer."
  }
}

variable "max_slots_per_request" {
  description = "Maximum number of slots that can be reserved in one request."
  type        = number
  default     = 50

  validation {
    condition     = var.max_slots_per_request >= 1 && floor(var.max_slots_per_request) == var.max_slots_per_request
    error_message = "max_slots_per_request must be a positive integer."
  }
}

variable "frontend_origin" {
  description = "Allowed frontend origin for backend CORS. Set this to the frontend Cloud Run URL after it is known."
  type        = string
  default     = "http://localhost:5173"
}

variable "firebase_web_api_key" {
  description = "Firebase Web API key embedded into the frontend build."
  type        = string
  sensitive   = true
}

variable "firebase_web_app_id" {
  description = "Firebase Web App ID embedded into the frontend build."
  type        = string
  sensitive   = true
}

variable "firebase_auth_domain" {
  description = "Firebase Auth domain. Defaults to firebase_project_id.firebaseapp.com when empty."
  type        = string
  default     = ""
}

variable "firestore_database_id" {
  description = "Firestore database ID."
  type        = string
  default     = "(default)"
}

variable "backend_initial_image" {
  description = "Initial image used when Terraform creates the backend Cloud Run service. Cloud Build updates it later."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "frontend_initial_image" {
  description = "Initial image used when Terraform creates the frontend Cloud Run service. Cloud Build updates it later."
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}
