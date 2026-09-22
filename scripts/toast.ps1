param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Body
)

$ErrorActionPreference = 'Stop'

try {
    Add-Type -AssemblyName PresentationFramework
    Add-Type -AssemblyName PresentationCore
    Add-Type -AssemblyName WindowsBase
    Add-Type -AssemblyName System.Windows.Forms

    [xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        Width="460" SizeToContent="Height" MaxHeight="360"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ResizeMode="NoResize">
  <Border Background="#F2161A22" BorderBrush="#3B82F6" BorderThickness="2"
          CornerRadius="12" Padding="18">
    <Border.Effect>
      <DropShadowEffect Color="#000000" BlurRadius="18" ShadowDepth="4" Opacity="0.45" />
    </Border.Effect>
    <Grid>
      <Grid.RowDefinitions>
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
        <RowDefinition Height="Auto" />
      </Grid.RowDefinitions>
      <TextBlock Name="TitleText" Grid.Row="0" Foreground="#FFFFFF"
                 FontFamily="Microsoft YaHei UI" FontWeight="SemiBold" FontSize="19"
                 TextWrapping="Wrap" />
      <TextBlock Name="BodyText" Grid.Row="1" Margin="0,10,0,0" Foreground="#DCE7F7"
                 FontFamily="Microsoft YaHei UI" FontSize="14" LineHeight="22"
                 TextWrapping="Wrap" />
      <TextBlock Grid.Row="2" Margin="0,12,0,0" Foreground="#7F8EA3"
                 FontFamily="Microsoft YaHei UI" FontSize="11"
                 Text="Click to close / closes automatically in 12 seconds" />
    </Grid>
  </Border>
</Window>
'@

    $reader = New-Object System.Xml.XmlNodeReader $xaml
    $window = [Windows.Markup.XamlReader]::Load($reader)
    $window.FindName('TitleText').Text = $Title
    $window.FindName('BodyText').Text = $Body

    $window.Add_ContentRendered({
        $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $window.Left = $area.Right - $window.ActualWidth - 18
        $window.Top = $area.Bottom - $window.ActualHeight - 18
        [System.Media.SystemSounds]::Information.Play()
    })
    $window.Add_MouseLeftButtonUp({ $window.Close() })

    $timer = New-Object Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds(12)
    $timer.Add_Tick({
        $timer.Stop()
        $window.Close()
    })
    $timer.Start()
    $window.ShowDialog() | Out-Null
    exit 0
} catch {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shell.Popup("$Title`n`n$Body", 12, 'Delta Harvest Advisor', 64) | Out-Null
        exit 0
    } catch {
        Write-Error $_
        exit 1
    }
}
