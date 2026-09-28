# Go live from your browser: no OBS, no downloads, no follower minimum

You can start a live stream on OpenVibe.Live from a web browser, with nothing to install and no follower, subscriber or equipment requirement. Open the site, press **Go Live**, allow your camera and microphone, and you are live. It works on a Chromebook, a laptop or a phone. OpenVibe.Live is open source and run by its community.

## How to go live in your browser

1. Open [openvibe.live](https://openvibe.live) in Chrome, Edge, Firefox or Safari.
2. Sign in, or make an account. It takes a minute, and your channel exists as soon as you do (`openvibe.live/@yourname`).
3. Press **Go Live** in the top bar.
4. Allow your camera and microphone when the browser asks.
5. Give the stream a title and press **Start**. You are live, with your own channel page and chat.

## What you need

- **A modern browser:** Chrome, Edge, Firefox or Safari, on Windows, macOS, Linux, ChromeOS, Android or iOS.
- **A camera and a microphone:** the ones built into your laptop or phone are enough. You can also share your screen instead of a camera.
- **An OpenVibe account.**

You don't need any of the following:
- **Software:** no OBS, Streamlabs or plug-ins.
- **An audience:** no minimum number of followers or subscribers, and no history of past streams.
- **Equipment:** no capture card or gaming PC.

## What you can do while live

- **Switch cameras:** front and back on a phone, or any connected webcam.
- **Share your screen,** a window or a tab. You can also show your camera as a picture-in-picture over it.
- **Mute** your microphone or turn off your camera without ending the stream.
- **Watch your stream's health:** bitrate, frame rate and resolution.
- **Chat with viewers** on the same page. Your stream can be kept as a VOD, and people can clip it.

Your stream reaches viewers over **WebRTC**, with less than a second of delay. That is fast enough for a real conversation with chat, and for viewers to control a robot or camera in real time.

## When to use OBS instead

The browser is the fastest way to start. For a produced show with scenes, overlays and several sources, OpenVibe.Live also takes **OBS or any RTMP encoder**, **WHIP** (OBS 30+, ffmpeg, GStreamer or your own web page) and **ffmpeg** from a command line, such as from a Raspberry Pi. See [Broadcasting](broadcasting.md) for every method, and the [WHIP ingest API](whip.md) to publish from your own site.

## Questions

**Can I stream without OBS?**
Yes. OpenVibe.Live has a browser broadcaster built in. Press Go Live and allow your camera and microphone.

**Do I need followers or subscribers to go live?**
No. Every account can go live from the first minute. There is no follower, subscriber, age-of-account or past-stream requirement.

**Can I stream from a Chromebook or a phone?**
Yes. The broadcaster runs in the browser, so it works on ChromeOS, Android and iOS as well as Windows, macOS and Linux.

**Can I share my screen?**
Yes. Share a screen, a window or a browser tab, with or without your camera over it.

**Is there a delay?**
Browser broadcasts use WebRTC, with less than a second of delay.

**Is it open source?**
Yes. The code is at [github.com/OpenVibers/OpenVibe.Live](https://github.com/OpenVibers/OpenVibe.Live), and the platform is part of the OpenVibe network: one account works across all of its sites.
