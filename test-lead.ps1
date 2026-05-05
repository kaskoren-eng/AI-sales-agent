# AI Sales Agent - Test Script
# Run this AFTER the server is started with: npm run dev

$BASE = "http://localhost:3000"

Write-Host "`n=== STEP 1: Create Tenant ===" -ForegroundColor Cyan
$tenant = Invoke-RestMethod -Uri "$BASE/api/v1/tenants" `
  -Method POST `
  -ContentType "application/json" `
  -Body '{"name":"My Agency","slug":"my-agency"}'

$tenantId = $tenant.id
$apiKey   = $tenant.apiKey
Write-Host "Tenant ID : $tenantId"
Write-Host "API Key   : $apiKey"

Write-Host "`n=== STEP 2: Configure Lead-Intake Flow ===" -ForegroundColor Cyan
$flow = @{
  flowName = "lead-intake"
  flow = @{
    enabled = $true
    steps = @(
      @{
        type = "send_whatsapp"
        delayMinutes = 0
        content = @{
          messageType = "text"
          text = "Hi {{name}}, thanks for your interest! We'll be in touch shortly."
        }
      },
      @{
        type = "make_call"
        delayMinutes = 1
      }
    )
  }
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Uri "$BASE/api/v1/tenants/$tenantId/flows" `
  -Method PUT `
  -ContentType "application/json" `
  -Headers @{ Authorization = "Bearer $apiKey" } `
  -Body $flow | Out-Null

Write-Host "Flow configured."

Write-Host "`n=== STEP 3: Submit Test Lead ===" -ForegroundColor Cyan
$lead = @{
  tenant_id = $tenantId
  name      = "Test Lead"
  phone     = "+17405285414"
} | ConvertTo-Json

$result = Invoke-RestMethod -Uri "$BASE/webhooks/leads" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-webhook-secret" = "my-webhook-secret-123" } `
  -Body $lead

Write-Host "Lead ID: $($result.leadId)"
Write-Host "`nDone! Check the server logs — WhatsApp fires immediately, call triggers in 1 minute." -ForegroundColor Green
