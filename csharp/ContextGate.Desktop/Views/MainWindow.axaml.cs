using System;
using Avalonia.Controls;
using Avalonia.Interactivity;
using Avalonia.Threading;
using ContextGate.Desktop.ViewModels;

namespace ContextGate.Desktop.Views;

public partial class MainWindow : Window
{
    private DispatcherTimer? _statsTimer;

    public MainWindow()
    {
        InitializeComponent();
        SetupStatsTimer();
    }

    private void SetupStatsTimer()
    {
        _statsTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(5)
        };
        _statsTimer.Tick += OnStatsTimerTick;
        _statsTimer.Start();
    }

    private void OnStatsTimerTick(object? sender, EventArgs e)
    {
        if (DataContext is MainWindowViewModel vm)
        {
            vm.RefreshStats();
        }
    }

    private void MinimizeClick(object? sender, RoutedEventArgs e)
    {
        WindowState = WindowState.Minimized;
    }

    private void MaximizeClick(object? sender, RoutedEventArgs e)
    {
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    }

    private void CloseClick(object? sender, RoutedEventArgs e)
    {
        Close();
    }

    private void SwitchSettingsTab(object? sender, RoutedEventArgs e)
    {
        if (sender is Button btn && DataContext is MainWindowViewModel vm && btn.CommandParameter is string param && int.TryParse(param, out int index))
        {
            vm.SettingsTabIndex = index;
        }
    }

    protected override void OnClosing(WindowClosingEventArgs e)
    {
        _statsTimer?.Stop();
        base.OnClosing(e);
    }
}
