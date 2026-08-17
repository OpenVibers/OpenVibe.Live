# OVH Public Cloud Sizing Guide for OpenVibe.Live

This document compares the OVH Public Cloud plans you listed for running OpenVibe.Live, with a focus on:

- single-server deployment economics
- storage for VODs, clips, thumbnails, and app data
- live streaming up to roughly 200 concurrent viewers
- tradeoffs between **WebRTC**, **JSMPEG**, and **RTMP** delivery paths
- how far the OVH **$200 / 90-day** public-cloud credit goes

The analysis assumes the current OpenVibe.Live architecture in [server/index.js](server/index.js) and [server/config.js](server/config.js), where the application can expose:

- the main Node/Express app on `3000`
- WebSocket services
- RTMP ingest
- JSMPEG relay ports
- optional WebRTC / `mediasoup`
- local VOD / clip / thumbnail / emote / avatar storage under `data/`

---

## Executive summary

### Best overall pick

If you want **one OVH instance that makes the most sense for real OpenVibe.Live production**, the best all-around choice from the list is:

- **B3-32**

Why:

- 32 GB RAM is enough for Node, SQLite, WebSockets, chat, thumbnails, clips, and moderate media workload
- 8 vCores is a sane floor for a mixed single-box deployment
- 200 GB NVMe is much more realistic than 50–100 GB once VODs and clips start accumulating
- 2 Gbit/s leaves real headroom for 200 viewers at practical streaming bitrates
- the price jump from `B3-16` to `B3-32` is small compared with the gain in RAM, bandwidth, and storage

### Best budget / staging pick

- **B3-8** if you want the cheapest decent general-purpose box
- **C3-8** if you want a cheaper CPU-heavier test box and do not care about having only 100 GB storage

### Best safer production pick for 200-viewer WebRTC-heavy usage

- **B3-64**

Why:

- 16 vCores is a much healthier place to be if you expect 200 viewers with more WebRTC usage, call features, game traffic, clip creation, and multiple real-time subsystems running at once
- 4 Gbit/s helps if your viewer bitrate climbs or you have more than one stream / camera / room pattern later

### Families that make the least sense here

For OpenVibe.Live, the **older B2** and **older C2** families mostly lose on price/performance against the new **B3** and **C3** families.

In practice:

- **B3 beats B2** for most balanced OpenVibe.Live use
- **B3 or B3-64 often beats C3 as well**, unless you are extremely CPU-centric and can live with less storage / bandwidth for the money
- **C2** is the least attractive family in this list for this workload

---

## 1. What actually limits OpenVibe.Live on a single OVH instance

For OpenVibe.Live, the bottleneck is not just RAM.

The main constraints are:

1. **Outbound bandwidth**
2. **CPU**
3. **Disk space**
4. **Disk I/O**
5. **Operational headroom** for Node, FFmpeg, thumbnails, clips, chat, and WebSockets

### Outbound bandwidth is the first hard wall

For all three playback methods, if the origin server is doing the actual delivery, your OVH network cap matters a lot:

- **JSMPEG**: the server relays the live stream to every viewer
- **RTMP playback / HTTP-FLV style delivery**: the server still pays outbound bandwidth per viewer
- **WebRTC SFU**: the server forwards media to each viewer; outbound still scales with audience size

Cloudflare can protect the website and proxied HTTP traffic, but **raw media ports and direct real-time traffic are not magically offloaded** just because the website uses Cloudflare.

### CPU becomes more important for WebRTC than for simple relay paths

Relative server-side cost, roughly:

- **JSMPEG**: usually more bandwidth-bound than CPU-bound on the server side
- **RTMP ingest + direct playback**: also heavily bandwidth-bound
- **WebRTC / mediasoup**: usually more CPU-sensitive because of SFU packet forwarding, transport handling, encryption overhead, and more real-time state

### Storage dominates once VODs are enabled

The current codebase stores locally:

- SQLite database
- VODs
- clips
- thumbnails
- emotes
- avatars
- media assets

The OS and app do not need much space. **Recorded video does.**

---

## 2. Simple bandwidth math for 200 viewers

A useful first-order formula is:

$$
\text{required egress Mbps} \approx \text{viewer count} \times \text{average delivered Mbps per viewer}
$$

Examples for **200 viewers**:

- at **1.5 Mbps** average delivered bitrate: about **300 Mbps** raw egress
- at **2.5 Mbps** average delivered bitrate: about **500 Mbps** raw egress
- at **4.0 Mbps** average delivered bitrate: about **800 Mbps** raw egress

Real deployments need headroom for:

- TLS / protocol overhead
- chat, API, thumbnails, clips, admin traffic
- bitrate spikes
- multiple tabs / reconnections / bursts
- FFmpeg, VOD, and background jobs

So a safer planning rule is to target around **70% of the listed port speed** as usable sustained capacity.

### Practical safe viewer counts at 70% utilization

The table below assumes one stream and one average delivered bitrate.

| NIC cap | Safe usable Mbps | ~1.5 Mbps/viewer | ~2.5 Mbps/viewer | ~4.0 Mbps/viewer |
|---|---:|---:|---:|---:|
| 250 Mbit/s | 175 | 116 | 70 | 43 |
| 500 Mbit/s | 350 | 233 | 140 | 87 |
| 1,000 Mbit/s | 700 | 466 | 280 | 175 |
| 2,000 Mbit/s | 1400 | 933 | 560 | 350 |
| 4,000 Mbit/s | 2800 | 1866 | 1120 | 700 |
| 8,000 Mbit/s | 5600 | 3733 | 2240 | 1400 |
| 10,000 Mbit/s | 7000 | 4666 | 2800 | 1750 |
| 16,000 Mbit/s | 11200 | 7466 | 4480 | 2800 |

### What that means for 200 viewers

If you want room for **200 real viewers**:

- **250 Mbit/s plans** are not enough except maybe for very low bitrates and a soft audience ceiling
- **500 Mbit/s plans** can work for low-mid bitrate delivery, but they are not where I would want to be for a real 200-viewer goal
- **1 Gbit/s plans** are viable for 200 viewers if you keep average delivered bitrate moderate
- **2 Gbit/s plans** are where the setup gets comfortable
- **4 Gbit/s plans** are where you stop thinking about bandwidth first and start thinking more about CPU and storage

---

## 3. Storage math for VODs and clips

A fast rule of thumb:

$$
1\ \text{Mbps} \approx 0.44\ \text{GB/hour}
$$

So:

- **1.5 Mbps** ≈ **0.66 GB/hour**
- **2.5 Mbps** ≈ **1.10 GB/hour**
- **4.0 Mbps** ≈ **1.76 GB/hour**
- **6.0 Mbps** ≈ **2.64 GB/hour**

### Why 50–100 GB fills quickly

You should reserve space for:

- Ubuntu + packages + logs
- app code
- SQLite DB
- thumbnails, avatars, emotes
- temporary files during clip/VOD work

A practical reserve is roughly **15–25 GB**.

That means usable recording space looks more like:

| Raw disk | Rough usable media space after OS/app reserve |
|---|---:|
| 50 GB | 25–35 GB |
| 100 GB | 75–85 GB |
| 200 GB | 175–185 GB |
| 400 GB | 375–385 GB |

### Approximate retained recording hours

At **2.5 Mbps** average recording bitrate:

- 30 GB usable → about **27 hours**
- 80 GB usable → about **73 hours**
- 180 GB usable → about **164 hours**
- 380 GB usable → about **345 hours**

At **4.0 Mbps** average recording bitrate:

- 30 GB usable → about **17 hours**
- 80 GB usable → about **45 hours**
- 180 GB usable → about **102 hours**
- 380 GB usable → about **216 hours**

### Storage takeaway

For OpenVibe.Live with VODs enabled:

- **50 GB** is basically test-only
- **100 GB** is okay for dev / alpha / minimal retention
- **200 GB** is the first storage size that feels production-usable
- **400 GB** is much better, but still not archival scale if you keep lots of VODs

If your VOD library matters, the right long-term answer is usually:

- use local NVMe for active recordings and hot files
- push older VODs / archives to object storage or another storage layer later

---

## 4. Family-by-family analysis

## B3 family — best overall fit

The new B3 family is the strongest match for OpenVibe.Live because it balances:

- decent vCPU counts
- generous RAM
- NVMe storage
- strong network steps
- good pricing

### B3 plans

| Plan | RAM | vCPU | Disk | NIC | Price/hour |
|---|---:|---:|---:|---:|---:|
| B3-8 | 8 GB | 2 | 50 GB NVMe | 500 Mbit/s | $0.0508 |
| B3-16 | 16 GB | 4 | 100 GB NVMe | 1,000 Mbit/s | $0.1016 |
| B3-32 | 32 GB | 8 | 200 GB NVMe | 2,000 Mbit/s | $0.2033 |
| B3-64 | 64 GB | 16 | 400 GB NVMe | 4,000 Mbit/s | $0.4065 |
| B3-128 | 128 GB | 32 | 400 GB NVMe | 8,000 Mbit/s | $0.8131 |
| B3-256 | 256 GB | 64 | 400 GB NVMe | 16,000 Mbit/s | $1.6262 |

### B3 conclusions

- **B3-8**: good dev box, too small for serious 200-viewer ambitions
- **B3-16**: good small production / alpha / staging box
- **B3-32**: best overall single-box production choice
- **B3-64**: best safer serious production choice if you want 200 viewers with headroom
- **B3-128 / B3-256**: overkill for early OpenVibe.Live unless you are running much larger real-time workloads or multiple major streams/services on the same machine

---

## B2 family — older and mostly outclassed

### B2 plans

| Plan | RAM | vCPU | Disk | NIC | Price |
|---|---:|---:|---:|---:|---:|
| B2-7 | 7 GB | 2 | 50 GB SSD | 250 Mbit/s | $29.04/mo or $0.0813/h |
| B2-15 | 15 GB | 4 | 100 GB SSD | 250 Mbit/s | $55.44/mo or $0.1539/h |
| B2-30 | 30 GB | 8 | 200 GB SSD | 500 Mbit/s | $112.20/mo or $0.3123/h |
| B2-60 | 60 GB | 16 | 400 GB SSD | 1,000 Mbit/s | $217.80/mo or $0.6060/h |
| B2-120 | 120 GB | 32 | 400 GB SSD | 10,000 Mbit/s | $429.00/mo or $1.1923/h |

### B2 conclusions

Compared with B3, B2 generally gives you:

- worse price/performance
- older SSD instead of NVMe
- weaker bandwidth at comparable sizes

For OpenVibe.Live, I would only choose B2 if:

- you specifically need that family for quota / availability / billing reasons
- B3 is unavailable in your chosen zone

Otherwise B3 is better.

---

## C3 family — interesting for CPU-heavy real-time workloads, but not the best value here

### C3 plans

| Plan | RAM | vCPU | Disk | NIC | Price/hour |
|---|---:|---:|---:|---:|---:|
| C3-4 | 4 GB | 2 | 50 GB NVMe | 250 Mbit/s | $0.0453 |
| C3-8 | 8 GB | 4 | 100 GB NVMe | 500 Mbit/s | $0.0907 |
| C3-16 | 16 GB | 8 | 200 GB NVMe | 1,000 Mbit/s | $0.1813 |
| C3-32 | 32 GB | 16 | 400 GB NVMe | 2,000 Mbit/s | $0.3627 |
| C3-64 | 64 GB | 32 | 400 GB NVMe | 4,000 Mbit/s | $0.7254 |
| C3-128 | 128 GB | 64 | 400 GB NVMe | 8,000 Mbit/s | $1.4508 |

### C3 conclusions

C3 gets interesting if you believe the deployment will be heavily:

- WebRTC-centric
- CPU-bound
- real-time packet / transport heavy

But for OpenVibe.Live specifically, the B3 line still usually wins because the app is not a pure CPU benchmark. It is a mixed workload that also wants:

- more RAM
- more bandwidth
- more storage
- better economics per box

#### Example comparisons

- **B3-32**: 32 GB / 8 vCPU / 200 GB / 2 Gbit/s for **$0.2033/h**
- **C3-16**: 16 GB / 8 vCPU / 200 GB / 1 Gbit/s for **$0.1813/h**

For only a little more money, `B3-32` gives you:

- double the RAM
- double the network
- same storage
- same vCPU count

That is a better OpenVibe.Live trade most of the time.

- **B3-64**: 64 GB / 16 vCPU / 400 GB / 4 Gbit/s for **$0.4065/h**
- **C3-32**: 32 GB / 16 vCPU / 400 GB / 2 Gbit/s for **$0.3627/h**

Again, `B3-64` is only a bit more expensive while giving much more breathing room.

---

## C2 family — least attractive for this workload

### C2 plans

| Plan | RAM | vCPU | Disk | NIC | Price |
|---|---:|---:|---:|---:|---:|
| C2-7 | 7 GB | 2 | 50 GB SSD | 250 Mbit/s | $42.24/mo or $0.1176/h |
| C2-15 | 15 GB | 4 | 100 GB SSD | 250 Mbit/s | $81.83/mo or $0.2276/h |
| C2-30 | 30 GB | 8 | 200 GB SSD | 500 Mbit/s | $165.00/mo or $0.4586/h |
| C2-60 | 60 GB | 16 | 400 GB SSD | 1,000 Mbit/s | $323.40/mo or $0.8986/h |
| C2-120 | 120 GB | 32 | 400 GB SSD | 10,000 Mbit/s | $640.20/mo or $1.7786/h |

### C2 conclusions

C2 has higher listed GHz in this snapshot, but the family is much harder to justify because:

- it is expensive
- it is older
- it still often has weaker bandwidth than the B3 alternative
- the storage type is not as appealing as NVMe on B3/C3

I would not choose C2 for OpenVibe.Live unless there were some very specific external reason.

---

## 5. Method-by-method plan fit

## WebRTC / mediasoup

This is the method most likely to become **CPU-sensitive** first.

### Good choices

- **B3-32** for moderate production
- **B3-64** for safer 200-viewer production
- **C3-32** only if you are convinced CPU will matter more than RAM/bandwidth economics

### Avoid for 200-viewer goals

- `B3-8`, `B2-7`, `C3-4`, `C2-7`

### Practical recommendation

If your expected audience is really up to 200 and WebRTC is a real primary path, I would start at **B3-64**, not because 32 GB RAM is required, but because the full balance of:

- 16 vCores
- 4 Gbit/s
- 400 GB NVMe

is much healthier.

---

## JSMPEG

JSMPEG is typically more straightforward on the server side and becomes **bandwidth-bound** quickly.

### Good choices

- **B3-16** for smaller audiences and testing
- **B3-32** for up to 200 viewers at moderate bitrates
- **B3-64** if you want bitrate headroom or larger audience spikes

### Practical recommendation

For a JSMPEG-heavy public deployment, **B3-32** is the sweet spot.

---

## RTMP ingest + direct playback

RTMP ingest itself is light. Viewer delivery is what costs you.

If OpenVibe.Live is the box serving the live playback path, you again care most about:

- outbound bandwidth
- storage if recording VODs

### Good choices

- **B3-16** for low-mid audience counts
- **B3-32** for a real public rollout
- **B3-64** if you expect higher bitrate, spikes, or multiple simultaneous live loads

### Practical recommendation

Again, **B3-32** is the best overall one-box answer.

---

## 6. $200 OVH credit analysis

OVH gives **$200 in public cloud credit that expires after 90 days**.

That means there are two important questions:

1. how long the credit lasts if you run continuously
2. whether the plan can run the full 90 days within the credit window

### How long $200 lasts on each plan

| Plan | Price/hour | $200 lasts | Hours |
|---|---:|---:|---:|
| B3-8 | $0.0508 | 164.04 days | 3937.0 h |
| B3-16 | $0.1016 | 82.02 days | 1968.5 h |
| B3-32 | $0.2033 | 40.99 days | 983.8 h |
| B3-64 | $0.4065 | 20.50 days | 492.0 h |
| B3-128 | $0.8131 | 10.25 days | 246.0 h |
| B3-256 | $1.6262 | 5.12 days | 123.0 h |
| B2-7 | $0.0813 | 102.50 days | 2460.0 h |
| B2-15 | $0.1539 | 54.15 days | 1299.5 h |
| B2-30 | $0.3123 | 26.68 days | 640.4 h |
| B2-60 | $0.6060 | 13.75 days | 330.0 h |
| B2-120 | $1.1923 | 6.99 days | 167.7 h |
| C3-4 | $0.0453 | 183.96 days | 4415.0 h |
| C3-8 | $0.0907 | 91.88 days | 2205.1 h |
| C3-16 | $0.1813 | 45.96 days | 1103.1 h |
| C3-32 | $0.3627 | 22.98 days | 551.4 h |
| C3-64 | $0.7254 | 11.49 days | 275.7 h |
| C3-128 | $1.4508 | 5.74 days | 137.9 h |
| C2-7 | $0.1176 | 70.86 days | 1700.7 h |
| C2-15 | $0.2276 | 36.61 days | 878.7 h |
| C2-30 | $0.4586 | 18.17 days | 436.1 h |
| C2-60 | $0.8986 | 9.27 days | 222.6 h |
| C2-120 | $1.7786 | 4.69 days | 112.4 h |

### 90-day continuous run cost for hourly plans

| Plan | 30-day cost | 90-day cost |
|---|---:|---:|
| B3-8 | $36.58 | $109.73 |
| B3-16 | $73.15 | $219.46 |
| B3-32 | $146.38 | $439.13 |
| B3-64 | $292.68 | $878.04 |
| B3-128 | $585.43 | $1756.30 |
| B3-256 | $1170.86 | $3512.59 |
| C3-4 | $32.62 | $97.85 |
| C3-8 | $65.30 | $195.91 |
| C3-16 | $130.54 | $391.61 |
| C3-32 | $261.14 | $783.43 |
| C3-64 | $522.29 | $1566.86 |
| C3-128 | $1044.58 | $3133.73 |

### Best use of the free credit

If your goal is to stay inside the **full 90-day credit window**:

- **C3-4** fits easily, but is too small for serious public production
- **B3-8** fits easily and is a better balanced early-stage OpenVibe.Live box
- **C3-8** also fits the 90-day window and gives more CPU than B3-8
- **B3-16** almost makes it, but not quite; you would need extra spend after around **82 days**

### Best credit strategy

A practical strategy would be:

#### Strategy A — longest useful beta under credit

- run **B3-8** or **C3-8** during buildout, staging, feature validation, and low traffic
- upgrade to **B3-32** only when audience and VOD usage justify it

#### Strategy B — realistic public beta

- start on **B3-16**
- accept that the $200 credit covers only about **82 days**
- resize to **B3-32** when you actually need the larger bandwidth/storage envelope

#### Strategy C — short burst launch

- use **B3-32** for launch testing, promo, or a public event
- know that the $200 credit only gives you around **41 days** continuously

---

## 7. Recommended picks by scenario

## Scenario A — dev, staging, private alpha

### Pick

- **B3-8**

### Why

- cheapest balanced plan in the strong family
- enough for app setup, testing, internal streams, chat, docs, and smoke validation
- credit lasts long enough to cover the 90-day window easily

### Use if

- audience is small
- you are validating infrastructure
- you are not storing lots of VODs yet

---

## Scenario B — public beta, one main stream, realistic growth

### Pick

- **B3-16** if budget is tight
- **B3-32** if you want the plan that actually makes the most sense

### Why `B3-32` wins here

Compared with `B3-16`, it gives you:

- 2x RAM
- 2x vCPU
- 2x disk
- 2x network

for exactly 2x price, but the operational breathing room is much better.

For OpenVibe.Live, that extra room matters.

---

## Scenario C — target up to 200 concurrent viewers on one box

### Pick

- **B3-32** as the minimum serious answer
- **B3-64** as the safer answer

### Why

For 200 viewers, the question becomes:

- what is your average delivered bitrate?
- how WebRTC-heavy is the workload?
- how much VOD retention are you keeping locally?

If the deployment is mixed and audience is real, **B3-32** is the first plan that feels like a deliberate production choice rather than a compromise.

If you want less stress, especially with WebRTC and recording, use **B3-64**.

---

## Scenario D — WebRTC-first, higher CPU pressure, future growth

### Pick

- **B3-64**

### Why not `C3-32` first?

Because `B3-64` is only slightly more expensive and gives you:

- more RAM
- more network
- equivalent vCPU count
- better general OpenVibe.Live balance

---

## 8. Final recommendation

If you want the single OVH plan from this list that makes the most sense for OpenVibe.Live, including storage, mixed real-time features, and streaming toward **200 viewers**, choose:

## **B3-32**

That is the best overall compromise of:

- price
- RAM
- vCPU
- NVMe storage
- outbound bandwidth
- realism for local VOD/clip retention

If you want the safer no-regrets version for heavier WebRTC usage or more operational headroom, choose:

## **B3-64**

If you want the cheapest plan that is still worth using while you burn the free credit and build things out, choose:

## **B3-8**

---

## 9. Bottom line in one sentence

- **B3-8** = best cheap build/test box
- **B3-16** = okay starter production box
- **B3-32** = best overall OpenVibe.Live plan
- **B3-64** = best safer 200-viewer / WebRTC-heavy plan
- **B2 / C2** = mostly not worth it here
- **C3** = only worth it if you are unusually CPU-biased and accept weaker overall value for this app

---

## 10. OVH Ubuntu known gotcha — `node` not found

OVH Public Cloud instances running Ubuntu (especially 25.04) may not have `/usr/bin/node` after installing the NodeSource package. The `systemd` service will fail with:

```
/usr/bin/env: 'node': No such file or directory
```

After installing Node.js, verify and fix:

```bash
which node            # should print /usr/bin/node
sudo ln -sf "$(which node)" /usr/bin/node
```

See [SETUP.md](SETUP.md) §8 and §20 for the full fix.
