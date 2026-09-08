param(
    [Parameter(Mandatory = $true)]
    [string]$JpegPath,

    [string]$OutputPrefix = "",

    [int]$Width = 1280,

    [int]$Height = 1024
)

$resolved = Resolve-Path -LiteralPath $JpegPath
$data = [System.IO.File]::ReadAllBytes($resolved)

if ($data.Length -lt 4 -or $data[0] -ne 0xFF -or $data[1] -ne 0xD8) {
    throw "Input is not a JPEG file: $JpegPath"
}

if ([string]::IsNullOrWhiteSpace($OutputPrefix)) {
    $base = [System.IO.Path]::GetFileNameWithoutExtension($resolved.Path)
    $OutputPrefix = Join-Path (Get-Location) $base
}

$raw = New-Object System.Collections.Generic.List[byte]
$app3Segments = 0
$visualWidth = 0
$visualHeight = 0
$pos = 2

while ($pos -lt $data.Length) {
    if ($data[$pos] -ne 0xFF) {
        break
    }

    while ($pos -lt $data.Length -and $data[$pos] -eq 0xFF) {
        $pos++
    }

    if ($pos -ge $data.Length) {
        break
    }

    $marker = [int]$data[$pos]
    $pos++

    if (($marker -ge 0xD0 -and $marker -le 0xD9) -or $marker -eq 0x01) {
        if ($marker -eq 0xD9) {
            break
        }
        continue
    }

    if ($pos + 2 -gt $data.Length) {
        break
    }

    $segmentLength = ([int]$data[$pos] -shl 8) + [int]$data[$pos + 1]
    $segmentStart = $pos + 2
    $segmentEnd = $pos + $segmentLength

    if ($segmentEnd -gt $data.Length) {
        throw "Invalid JPEG segment length at offset $($pos - 2)"
    }

    if ($marker -eq 0xE3) {
        for ($i = $segmentStart; $i -lt $segmentEnd; $i++) {
            $raw.Add($data[$i])
        }
        $app3Segments++
    } elseif ($marker -eq 0xC0) {
        $visualHeight = ([int]$data[$segmentStart + 1] -shl 8) + [int]$data[$segmentStart + 2]
        $visualWidth = ([int]$data[$segmentStart + 3] -shl 8) + [int]$data[$segmentStart + 4]
    } elseif ($marker -eq 0xDA) {
        break
    }

    $pos = $segmentEnd
}

$rawBytes = $raw.ToArray()
$expectedBytes = $Width * $Height * 2
if ($rawBytes.Length -ne $expectedBytes) {
    throw "Unexpected APP3 payload size: $($rawBytes.Length), expected $expectedBytes for ${Width}x${Height} uint16"
}

$binPath = "${OutputPrefix}_temperature_matrix_u16le_${Width}x${Height}.bin"
[System.IO.File]::WriteAllBytes($binPath, $rawBytes)

$pixelCount = $Width * $Height
$minRaw = [int]::MaxValue
$maxRaw = [int]::MinValue
$sumRaw = 0.0
$minIndex = 0
$maxIndex = 0

for ($i = 0; $i -lt $pixelCount; $i++) {
    $rawValue = ([int]$rawBytes[2 * $i]) + (([int]$rawBytes[2 * $i + 1]) -shl 8)
    if ($rawValue -lt $minRaw) {
        $minRaw = $rawValue
        $minIndex = $i
    }
    if ($rawValue -gt $maxRaw) {
        $maxRaw = $rawValue
        $maxIndex = $i
    }
    $sumRaw += $rawValue
}

$avgRaw = $sumRaw / $pixelCount
$summary = @(
    "source=$($resolved.Path)",
    "visual_jpeg=${visualWidth}x${visualHeight}",
    "app3_segments=$app3Segments",
    "matrix=${Width}x${Height}",
    "matrix_bytes=$($rawBytes.Length)",
    "format=uint16 little-endian",
    "temperature_scale_guess=celsius = raw / 64 - 273.15",
    ("min_raw={0} min_celsius={1:F3} x={2} y={3}" -f $minRaw, ($minRaw / 64.0 - 273.15), ($minIndex % $Width), [int]($minIndex / $Width)),
    ("max_raw={0} max_celsius={1:F3} x={2} y={3}" -f $maxRaw, ($maxRaw / 64.0 - 273.15), ($maxIndex % $Width), [int]($maxIndex / $Width)),
    ("avg_raw={0:F3} avg_celsius={1:F3}" -f $avgRaw, ($avgRaw / 64.0 - 273.15)),
    "bin=$binPath"
)

$summaryPath = "${OutputPrefix}_temperature_matrix_summary.txt"
[System.IO.File]::WriteAllLines($summaryPath, $summary, [System.Text.Encoding]::UTF8)
$summary
