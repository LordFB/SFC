param(
  [Parameter(Mandatory = $true)]
  [string]$Path
)

$resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
$files = if ((Get-Item -LiteralPath $resolved).PSIsContainer) {
  Get-ChildItem -LiteralPath $resolved -Recurse -Filter '*.sfc'
} else {
  Get-Item -LiteralPath $resolved
}

$issues = [System.Collections.Generic.List[string]]::new()
$warnings = [System.Collections.Generic.List[string]]::new()

foreach ($file in $files) {
  $source = Get-Content -LiteralPath $file.FullName -Raw
  $tagMatch = [regex]::Match($source, 'static\s+tag\s*=\s*["''](?<tag>[a-z][a-z0-9-]*)["'']')
  $tag = if ($tagMatch.Success) { $tagMatch.Groups['tag'].Value } else { $null }
  $usesShadow = [regex]::IsMatch($source, 'static\s+(?:shadow|staticShadow)\s*=\s*true')

  $routeMatches = [regex]::Matches($source, '<route(?<attrs>[^>]*)/?>', 'IgnoreCase')
  foreach ($route in $routeMatches) {
    $attrs = $route.Groups['attrs'].Value
    $pathMatch = [regex]::Match($attrs, '\bpath\s*=\s*["''](?<path>[^"'']+)["'']', 'IgnoreCase')
    if ($pathMatch.Success -and $pathMatch.Groups['path'].Value.Contains(':') -and $attrs -notmatch '\bprerender\s*=') {
      $issues.Add("$($file.FullName): dynamic route '$($pathMatch.Groups['path'].Value)' needs prerender=`"<source>`" or prerender=`"skip`".")
    }
  }

  if ($usesShadow) {
    continue
  }

  $styleMatches = [regex]::Matches($source, '<style(?<attrs>[^>]*)>(?<css>[\s\S]*?)</style>', 'IgnoreCase')
  foreach ($style in $styleMatches) {
    if ($style.Groups['attrs'].Value -match '\bglobal\b') {
      continue
    }
    if (-not $tag) {
      $issues.Add("$($file.FullName): light-DOM style found without a detectable static tag.")
      continue
    }

    $css = [regex]::Replace($style.Groups['css'].Value, '/\*[\s\S]*?\*/', '')
    foreach ($line in ($css -split '\r?\n')) {
      if (-not $line.Contains('{')) {
        continue
      }
      $selectorList = $line.Substring(0, $line.IndexOf('{')).Trim()
      foreach ($rawSelector in $selectorList.Split(',')) {
        $selector = $rawSelector.Trim()
        if (
          -not $selector -or
          $selector.StartsWith('@') -or
          $selector.StartsWith('&') -or
          $selector -match '^(?:from|to|\d+%)$'
        ) {
          continue
        }
        if (
          $selector -notmatch "^$([regex]::Escape($tag))(?=$|[\s>+~.#:\[])" -and
          $selector -notmatch '^:host(?=$|[\s>+~.#:\[])'
        ) {
          $issues.Add("$($file.FullName): uncontained selector '$selector'; prefix it with '$tag'.")
        }
      }
    }
  }

  if ($source -match '(?:window|document)\.addEventListener' -and $source -notmatch 'disconnectedCallback\s*\(') {
    $warnings.Add("$($file.FullName): external listener detected without disconnectedCallback cleanup.")
  }
}

foreach ($warning in $warnings) {
  Write-Warning $warning
}
foreach ($issue in $issues) {
  Write-Error $issue
}

if ($issues.Count -gt 0) {
  exit 1
}

Write-Output "SFC audit passed for $($files.Count) file(s)."
