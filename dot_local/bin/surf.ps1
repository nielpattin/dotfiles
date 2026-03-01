param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$SurfArgs
)

Set-Location $env:USERPROFILE
& surf.exe @SurfArgs

if ($null -ne $LASTEXITCODE) {
    exit $LASTEXITCODE
}
