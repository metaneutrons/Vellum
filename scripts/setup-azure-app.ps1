<#
.SYNOPSIS
    Registers the Vellum Azure AD application with Microsoft Graph permissions.

.DESCRIPTION
    Creates an app registration, client secret, and grants admin consent
    for Calendars.Read and User.Read.All (application permissions).

    Outputs the values needed for .env.

.EXAMPLE
    Connect-MgGraph -Scopes "Application.ReadWrite.All","AppRoleAssignment.ReadWrite.All"
    ./scripts/setup-azure-app.ps1
#>

#Requires -Modules Microsoft.Graph.Applications, Microsoft.Graph.Identity.DirectoryManagement

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppName = "Vellum Display"
$SecretDescription = "Vellum backend"
$SecretMonths = 24

# ── Ensure we're connected ───────────────────────────────────────────

$ctx = Get-MgContext
if (-not $ctx) {
    Write-Host "Connecting to Microsoft Graph..." -ForegroundColor Cyan
    Connect-MgGraph -Scopes "Application.ReadWrite.All", "AppRoleAssignment.ReadWrite.All"
    $ctx = Get-MgContext
}

$TenantId = $ctx.TenantId
Write-Host "Tenant: $TenantId" -ForegroundColor Green

# ── Microsoft Graph service principal & app role IDs ─────────────────

$GraphSpn = Get-MgServicePrincipal -Filter "appId eq '00000003-0000-0000-c000-000000000000'"

$CalendarsRead = $GraphSpn.AppRoles | Where-Object { $_.Value -eq "Calendars.Read" }
$UserReadAll   = $GraphSpn.AppRoles | Where-Object { $_.Value -eq "User.Read.All" }

# ── Create app registration ──────────────────────────────────────────

Write-Host "Creating app registration '$AppName'..." -ForegroundColor Cyan

$RequiredAccess = @{
    ResourceAppId  = "00000003-0000-0000-c000-000000000000"  # Microsoft Graph
    ResourceAccess = @(
        @{ Id = $CalendarsRead.Id; Type = "Role" },
        @{ Id = $UserReadAll.Id;   Type = "Role" }
    )
}

$App = New-MgApplication `
    -DisplayName $AppName `
    -SignInAudience "AzureADMyOrg" `
    -RequiredResourceAccess @($RequiredAccess)

$ClientId = $App.AppId
Write-Host "  App ID:     $ClientId" -ForegroundColor Green

# ── Create client secret ─────────────────────────────────────────────

Write-Host "Creating client secret..." -ForegroundColor Cyan

$Secret = Add-MgApplicationPassword -ApplicationId $App.Id -PasswordCredential @{
    DisplayName = $SecretDescription
    EndDateTime = (Get-Date).AddMonths($SecretMonths)
}

$ClientSecret = $Secret.SecretText
Write-Host "  Secret:     $($ClientSecret.Substring(0,8))..." -ForegroundColor Green

# ── Create service principal & grant admin consent ───────────────────

Write-Host "Creating service principal..." -ForegroundColor Cyan

$Spn = New-MgServicePrincipal -AppId $ClientId

Write-Host "Granting admin consent..." -ForegroundColor Cyan

foreach ($Role in @($CalendarsRead, $UserReadAll)) {
    New-MgServicePrincipalAppRoleAssignment `
        -ServicePrincipalId $Spn.Id `
        -PrincipalId $Spn.Id `
        -ResourceId $GraphSpn.Id `
        -AppRoleId $Role.Id | Out-Null
    Write-Host "  Granted: $($Role.Value)" -ForegroundColor Green
}

# ── Output ───────────────────────────────────────────────────────────

Write-Host ""
Write-Host "════════════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host "  Add these to your .env file:" -ForegroundColor Yellow
Write-Host "════════════════════════════════════════════════════" -ForegroundColor Yellow
Write-Host ""
Write-Host "AZURE_TENANT_ID=$TenantId"
Write-Host "AZURE_CLIENT_ID=$ClientId"
Write-Host "AZURE_CLIENT_SECRET=$ClientSecret"
Write-Host ""
Write-Host "Secret expires: $(Get-Date (Get-Date).AddMonths($SecretMonths) -Format 'yyyy-MM-dd')" -ForegroundColor DarkGray
