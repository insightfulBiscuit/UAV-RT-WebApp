> **SUPERSEDED — do not review or deliver this file.**
> The current checklist is `city-compliance-checklist.tex`. This Markdown draft is
> retained for history only and contains known errors that were corrected in the
> `.tex`: the $5 registration fee (now $10), "legible from 30 cm" marking wording,
> "Life of program" retention for CAR 901.49 incident records (the requirement is
> 12 months), an external TC report described as automatic for every 901.49 event,
> insurance described as effectively required, the "review at least annually"
> closing sentence, and a combined "Advanced/Sheltered" profile that the `.tex`
> now splits into three. Two links in it are also dead.

# Regulatory & Operational Compliance Checklist — City of Kelowna

**Purpose.** This document is the City's post-handover regulatory punch list. The technical system (aircraft, dock, web app, AI alerting, telemetry) is being delivered ready to fly, but a Remotely Piloted Aircraft System (RPAS) cannot lawfully be operated in Canada on hardware alone. Transport Canada, NAV CANADA, and — depending on the mission profile — an SFOC-RPAS regime each impose their own certificates, authorizations, and record-keeping obligations. All of the items below are the **City's responsibility to obtain, hold, or maintain** before and during legal operation of the system.

**Scope.** Small RPAS (250 g – 25 kg), Advanced Operations, with a Sheltered Operations profile as the primary mission (per the accompanying *Sheltered Operations Pathway* document). Optional BVLOS/Level 1 Complex is called out where it becomes relevant.

**Legend.**
- **Required** — legally mandatory before any flight in this profile.
- **Conditional** — required only if the mission triggers it (BVLOS, advertised events, aerodrome proximity, etc.).
- **Confirm** — the City must verify current status (e.g. recency dates, insurance renewals) even if the certificate itself exists.

**Regulatory reference base.** *Canadian Aviation Regulations* (CARs), Part IX — Remotely Piloted Aircraft Systems, Subpart 1 (§901.01 – §901.76) and Subpart 3 (SFOC-RPAS). The applicable Advanced/Sheltered rules cited throughout are §901.23 (procedures), §901.24 (pre-flight), §901.27 (site survey), §901.48 (records), §901.49 (occurrences), §901.63–66 (pilot), §901.71–74 (Advanced/Sheltered operating conditions).

---

## 1. Pilot qualifications

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 1.1 | **Pilot Certificate — RPAS — Advanced Operations** | Legal authority for the named pilot to conduct Advanced operations, including Sheltered Operations in controlled airspace. Required by CAR 901.63/901.64. | City (pilot named on certificate) | Transport Canada *Drone Management Portal* — [Getting a drone pilot certificate](https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/getting-drone-pilot-certificate). Requires the Small Advanced online exam **plus** an in-person flight review with a TC-approved reviewer. | **Required** | This is the minimum certificate for the Sheltered profile. Level 1 Complex is *not* needed just because the drone loses VLOS behind a building. |
| 1.2 | **Pilot recency evidence (24 months)** | Keeps the Advanced certificate operationally valid. CAR 901.65 requires one qualifying event (issuance, exam pass, flight review, or recurrent training) in the preceding 24 months. | City | Internal training log; TC exam or flight-review records; recognized recurrent training. See [Complete a flight review for drones](https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/complete-flight-review-drones). | **Confirm** every 24 months | Set a calendar reminder. Pilot is grounded the day recency lapses even if the certificate still displays "Advanced." |
| 1.3 | **Pilot Certificate — Level 1 Complex Operations** *(only if the City chooses to pursue BVLOS)* | Required for lower-risk BVLOS beyond what Sheltered allows. Requires Advanced first, then 20 h ground school from a recognized flight school, Level 1 Complex online exam, and a Level 1 Complex flight review. | City | [Take a drone pilot online exam: Level 1 Complex](https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/take-drone-pilot-online-exam/level-1-complex). $125 issuance fee. Pilot must be ≥18. | **Conditional** — only if BVLOS beyond Sheltered is intended | Not required to operate the delivered system. Flagged so the City understands the escalation path. |
| 1.4 | **Documents immediately accessible during operation** | CAR 901.66 requires the pilot certificate and recency evidence to be easily accessible to the pilot at the control station during the flight. | City (pilot) | Digital copy on the controller/tablet; PDF pilot-qualification package. | **Required** | Include in the "Pilot Package" folder recommended in §5 of the *Sheltered Operations Pathway*. |
| 1.5 | **Internal M4TD type competency** | Not a Transport Canada certificate — an internal City-level currency record showing this pilot has trained on this airframe. | City | Internal training log; DJI/vendor training records. | Recommended | Protects the City in the event of an incident review or insurance claim. |

---

## 2. Aircraft eligibility, registration & marking

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 2.1 | **Aircraft registration (Certificate of Registration)** | Required for any RPAS >250 g under CAR 901.02 and the current Standard 921 registration rules. | City (registered owner) | Transport Canada *Drone Management Portal* — [Register your drone](https://tc.canada.ca/en/aviation/drone-safety/drone-safety-tips-rules/register-your-drone). $5 per aircraft. | **Required** — one per airframe | Register *each* aircraft (M4TD, M400, Dock 3 airframe) separately. Keep the PDF certificate accessible to the pilot per CAR 901.29. |
| 2.2 | **Registration number marked on the aircraft** | Standard 921 requires the C-XXXXXXX registration number to be marked on the drone and legible from 30 cm before first flight. | City | Permanent marker, engraving, or a durable label. Reference: [Drone Registration Canada: CARs 901 Marking Rules](https://compliancelettering.ca/blog/drone-registration-canada-guide/). | **Required** | Re-mark if the label is damaged or the aircraft shell is replaced. |
| 2.3 | **Manufacturer Safety Assurance Declaration (RPAS Safety Assurance) — §922.04 (Sheltered)** | Establishes that the M4TD/M400 meets the applicable Standard 922 requirements for the intended operation (Advanced → Sheltered in controlled airspace). | Manufacturer (DJI) — the City verifies and retains a copy | Look up the airframe in Transport Canada's [Safety Assurance Declarations list](https://tc.canada.ca/en/aviation/drone-safety/submitting-drone-safety-assurance-declaration) and download the current declaration PDF. | **Required (verify)** | The M4TD is currently listed against 922.04 (Sheltered). Any modification (third-party payload, non-standard battery) may invalidate the declaration per CAR 901.70 — do not add hardware without checking. |
| 2.4 | **Aircraft configuration baseline** | Evidence that the flying configuration matches the declared configuration. | City | Internal record: model, firmware version, controller, batteries, payload/gimbal, accessories, any modifications. | **Required** | Snapshot after each firmware update. |

---

## 3. Airspace authorizations

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 3.1 | **NAV Drone account (organizational)** | The account through which NAV CANADA controlled-airspace authorizations are requested and issued. | City | [NAV Drone](https://www.navdrone.ca/) — create an operator account. Requires a verified mobile number, the Advanced-pilot certificate, and the aircraft registration. | **Required** | Register the account to the City (or the operating department) rather than to an individual staff member so it survives personnel changes. |
| 3.2 | **NAV CANADA RPAS Flight Authorization (per operation)** | CAR 901.71 prohibits operation in controlled airspace without authorization from the air traffic services provider. Kelowna's downtown and much of the operating area sit inside CYLW-controlled airspace. | City (pilot) | Submit the operation in NAV Drone. Reference: [NAV Drone Mobile: Geozones and NOTAMs](https://www.navcanada.ca/en/nav-drone-mobile-geozones-and-notams.aspx). | **Required per flight** in controlled airspace | For Advanced → Sheltered: automatic authorization if all overlapping grid cells are >100 ft; manual NAV CANADA review if any grid cell is ≤100 ft. Wait for **Accepted** — "Authorization required" is not the same as "authorized." |
| 3.3 | **RPAS Operation Summary retained and accessible in-flight** | CAR 901.71(3) requires the authorization to be easily accessible to the pilot during the operation. | City (pilot) | Download the RPAS Operation Summary PDF from NAV Drone's operation details after status = Accepted; store on the controller/tablet. | **Required** | Keep a local copy — cellular coverage cannot be assumed. |
| 3.4 | **Aerodrome / heliport proximity check** | CAR 901.73 prohibits operation within 3 NM of an airport or 1 NM of a heliport unless the published procedure for that site is followed. | City (pilot) | Site-survey step. Identify Kelowna International Airport (CYLW), the Kelowna General Hospital heliport, and any private heliports within the survey radius. Cross-check via NAV Drone geo-zones. | **Required (per site)** | Downtown Kelowna sits well within 3 NM of CYLW — expect authorization to always be needed. |
| 3.5 | **NOTAM review before every flight** | CAR 901.24 pre-flight information review; site-survey requirement under CAR 901.27. | City (pilot) | NAV Drone in-app NOTAMs; [NAV CANADA NOTAMs](https://plan.navcanada.ca/wxrecall/). | **Required per flight** | Record the NOTAM check in the flight log. |

---

## 4. Operational approvals: SFOC-RPAS and Level 1 Complex

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 4.1 | **SFOC-RPAS (Special Flight Operations Certificate — RPAS)** | Required for operations outside the standard Advanced envelope and outside Level 1 Complex — e.g. BVLOS not covered by Level 1 Complex, operations >122 m AGL in uncontrolled airspace, RPAS >150 kg, carrying dangerous payloads, some advertised events. | City (organization) | Transport Canada — [Getting a Special Flight Operations Certificate for a Remotely Piloted Aircraft System](https://tc.canada.ca/en/aviation/drone-safety/getting-special-flight-operations-certificate-remotely-piloted-aircraft-system). AC 903-002 gives guidance. | **Not required** for the Sheltered profile as delivered. **Conditional** if the City later expands scope. | Minimum 60 business-day lead time for medium/high-complexity SFOCs — plan ahead. |
| 4.2 | **RPAS Operator Certificate (RPOC)** | As of **4 November 2025**, any organization conducting Level 1 Complex operations or lower-risk BVLOS must hold, or be affiliated with, an RPOC. It certifies the *organization*'s safety management, personnel, training, procedures, and maintenance program. | City (organization) | Transport Canada — [Apply for an RPAS Operator Certificate (RPOC)](https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/apply-rpas-operator-certificate-rpoc). Guidance in AC 901-002. Declaration submitted through the *Drone Management Portal*. | **Not required** for Advanced → Sheltered. **Required** if the City ever conducts Level 1 Complex or lower-risk BVLOS. | Non-compliance penalties: up to $1,000 (individuals) / $5,000 (corporations). If the City wants a future BVLOS pathway, start the RPOC manual and safety-management docs early — it is not a single-day process. |
| 4.3 | **Site-specific operating procedure for advertised events** | An SFOC is required to fly micro or small drones at an *advertised event* regardless of category. | City | Transport Canada SFOC-RPAS process (see 4.1). | **Conditional** | Trigger the SFOC track if the City ever pairs drone footage with a public/advertised event (festival, parade, etc.). |

---

## 5. Site assessment & operating-area documentation

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 5.1 | **Site survey (per operating location)** | CAR 901.27 mandates a documented site survey covering airspace, NOTAMs, takeoff/landing/recovery, other aircraft, aerodromes/heliports, obstacles, weather/environment, and — specifically for Sheltered — the horizontal distance from uninvolved persons. | City (pilot) | Internal template. See §9 of the *Sheltered Operations Pathway* handoff document. | **Required per site** | Keep one signed survey per operating location; re-survey when site conditions change. |
| 5.2 | **Sheltered operating-volume definition** | Establishes the four hard boundaries every Sheltered flight has to respect simultaneously: 61 m from structure, +30 m above structure, 2 NM from pilot/GCS, 30 m from uninvolved persons (CAR 901.74). | City (pilot) | Site-survey document with a scaled diagram of the operating volume. | **Required per site** | Include building height, roof geometry, adjacent structures, antennas, cranes, wires, and the 30-m people buffer. |
| 5.3 | **People-control plan** | The 30 m from uninvolved persons rule (CAR 901.74(1)(c)) is not waived by the structure. In downtown Kelowna this is often the binding constraint. | City | Barriers, cones, spotters, temporary access restrictions, scheduling — documented per site. | **Required per site** | Coordinate with City Bylaw/RCMP for pedestrian control where needed. |
| 5.4 | **Takeoff / landing / recovery site designated** | CAR 901.74(1)(a) requires the pilot and control station to be *at* the takeoff/landing/recovery site during those activities. | City (pilot) | Marked on site diagram. | **Required per site** | A Dock 3 permanent installation counts as a designated site — document it once and reference. |

---

## 6. Normal & emergency operating procedures

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 6.1 | **Written normal operating procedures** | CAR 901.23 requires documented procedures for pre-flight, takeoff, launch, approach, landing, and recovery. | City | Internal SOP document (Sheltered-specific). | **Required** | Do not rely on the DJI generic checklist alone. |
| 6.2 | **Written emergency procedures** | CAR 901.23 requires procedures for control-station failure, equipment failure, aircraft failure, loss of C2, fly-away, flight termination, and detection/avoidance of conflicting aircraft. | City | Internal SOP document. | **Required** | |
| 6.3 | **Lost-link / RTH procedure calibrated per site** | Sheltered operations deliberately hide the drone behind the structure, so the default DJI RTH behavior must be evaluated against each building. | City | Internal SOP; per-site RTH altitude, first-waypoint, and abort behavior configured on the aircraft. | **Required per site** | Answer explicitly: does it hover, land, RTH? At what altitude? What if RTH pulls it away from the sheltered volume? What if GNSS is degraded? |
| 6.4 | **Pre-flight information review** | CAR 901.24. | City (pilot) | Internal pre-flight checklist — weather, NOTAMs, NAV Drone authorization, site survey, aircraft condition, pilot qualification, people-control status. | **Required per flight** | Sign off in the flight log. |

---

## 7. Records the City must keep

| # | Requirement | What it is for | Responsible | Where kept | Retention | Notes |
|---|---|---|---|---|---|---|
| 7.1 | **Flight logs** | CAR 901.48 — pilot and other crew on each flight, and flight time. | City | Internal log (spreadsheet, flight-log app, or the delivered web app's records). | **12 months** (regulatory minimum); recommend 5+ years as municipal policy | |
| 7.2 | **Maintenance, modification & repair records** | Standard 921 / CAR 901.28 — evidence the aircraft is maintained per the manufacturer's instructions, with mandatory actions completed. | City | Aircraft technical record per airframe (serial, TC registration, firmware, battery cycles, propeller changes, inspections, modifications, repairs). | **24 months** (regulatory minimum); recommend life-of-aircraft | Include battery-lifecycle tracking for LiPo/LiHV packs. |
| 7.3 | **Incident / occurrence records** | CAR 901.49 requires the operator to stop operations after certain incidents (injury, contact with a person, significant damage, boundary excursion, collision or risk of collision, fly-away, applicable CADORS-reportable events) until root cause and corrective action are documented. | City | Internal incident log; corrective-action record. | Life of program | See §8 for the report-out obligations. |
| 7.4 | **Training & competency records** | Evidence for both TC recency and City internal type competency (item 1.5). | City | HR / training file. | Life of employment + 7 years (typical municipal HR retention) | |
| 7.5 | **Authorizations & declarations file** | Registration certificates, NAV CANADA authorizations, manufacturer safety-assurance PDFs, SFOCs/RPOC if applicable. | City | Central digital folder mirroring the 7-folder structure in the *Sheltered Operations Pathway*. | Life of program | Recommend versioned storage (SharePoint / OneDrive / Records Management). |

---

## 8. Occurrence & incident reporting (external)

| # | Requirement | What it is for | Responsible | Where to report | Status | Notes |
|---|---|---|---|---|---|---|
| 8.1 | **Transport Canada drone incident report** | Single-entry-point online tool for reporting drone incidents to TC. | City | [Report a drone incident](https://tc.canada.ca/en/aviation/drone-safety/report-drone-incident) | **Required** when a CAR 901.49-triggering event occurs | |
| 8.2 | **Transportation Safety Board (TSB) report** | TSB investigates accidents/incidents involving RPAS >25 kg or serious injury/fatality. | City | [Report an air transportation occurrence](https://www.bst.gc.ca/eng/incidents-occurrence/aviation/index.html) | **Conditional** — triggers only on serious injury/fatality or on an RPAS >25 kg | Applies to the M400 if it ever crosses the 25-kg MTOW threshold in a given configuration. |
| 8.3 | **CADORS awareness** | The *Civil Aviation Daily Occurrence Reporting System* is the master aviation-occurrence record; NAV CANADA feeds most drone-related entries. | City | [CADORS Manual TP 4044](https://tc.canada.ca/en/aviation/aviation-publications/civil-aviation-daily-occurrence-reporting-system-cadors-manual-tp-4044) — for context; direct filing is via 8.1/8.2 above. | Reference | Airspace excursions near CYLW are likely to appear in CADORS via NAV CANADA regardless of what the City files. |

---

## 9. Insurance

| # | Requirement | What it is for | Responsible | Where to obtain | Status | Notes |
|---|---|---|---|---|---|---|
| 9.1 | **Aviation / RPAS liability insurance** | Covers third-party injury/property damage arising from RPAS operations. **A standard municipal general-liability policy will *not* respond** — the CGL aviation exclusion applies. Aviation-specific coverage is required. | City (Risk Management) | Aviation broker (e.g. Front Row Insurance, Air 1, or the City's existing aviation broker). Reference: [Drone Insurance in Canada — 2026](https://rpaswilco.com/blog/drone-insurance-canada). | **Not required by CARs**, but effectively **Required** by (a) municipal risk policy, (b) any client agreement, and (c) as a de facto pre-condition of any SFOC. | Municipal norm: **$2M–$5M CAD aviation liability**. Confirm limits with the City's Risk Management department. |
| 9.2 | **Certificate of Insurance accessible in-flight (recommended)** | Not a CAR requirement, but often a client/permit condition and useful in an incident. | City | From the broker after binding. | Recommended | Store alongside the pilot package. |

---

## 10. Kelowna-specific & municipal considerations

| # | Requirement | What it is for | Responsible | Where to obtain / apply | Status | Notes |
|---|---|---|---|---|---|---|
| 10.1 | **CYLW (Kelowna International) proximity** | Nearly all downtown Kelowna operating areas sit within CYLW's 3 NM zone → NAV CANADA authorization always required (§3.2 above). | City | NAV Drone. | **Required per flight** | |
| 10.2 | **Kelowna General Hospital heliport (1 NM)** | Any operation within 1 NM must follow the heliport's established procedure or be authorized. | City (pilot) | Site-survey step; coordinate through NAV Drone / Interior Health if the survey shows overlap. | **Conditional** | Verify during site survey. |
| 10.3 | **Provincial parks & Parks Canada lands** | BC Parks and Parks Canada each impose their own drone restrictions independent of CARs. | City | [Parks Canada drone policy](https://parks.canada.ca/lhn-nhs/canaux-canals/drone); BC Parks land-use policy. | **Conditional** on operating location | Not a CARs matter — a land-use matter. |
| 10.4 | **Municipal privacy / *FOIPPA* compliance** | The delivered system captures video and AI alerts. BC's *Freedom of Information and Protection of Privacy Act* governs collection, use, retention, and access. | City (Privacy Officer / FOI Office) | Internal — a Privacy Impact Assessment (PIA) is the usual instrument. | **Confirm** internally | Not a Transport Canada requirement, but effectively required before operational deployment by a BC public body. |
| 10.5 | **Landowner permission for takeoff/landing sites** | Not a CARs matter, but a property-law matter — even municipal land often has jurisdictional overlays (parks, utilities, First Nations). | City | Internal land-use confirmation. | **Confirm per site** | |

---

## 11. Summary — what the City must have done before the first legal flight

The minimum set for the delivered Sheltered profile, in order:

1. **Register** the M4TD (and any other airframe in the fleet) with Transport Canada and mark it. *(items 2.1, 2.2)*
2. **Verify** that the manufacturer safety-assurance declaration for §922.04 (Sheltered) is on file for the airframe. *(item 2.3)*
3. **Assign** an Advanced-certified pilot with in-date recency, and store their credentials in the flight package. *(items 1.1, 1.2, 1.4)*
4. **Create** the City's organizational NAV Drone account and link pilot + aircraft. *(item 3.1)*
5. **Bind** aviation liability insurance at a limit approved by City Risk Management. *(item 9.1)*
6. **Complete** written SOPs (normal + emergency + lost-link), the site survey for the first operating location, and the operating-volume diagram. *(items 5.1, 5.2, 5.3, 6.1, 6.2, 6.3)*
7. **Complete** a Privacy Impact Assessment for the video and AI-alert data flow. *(item 10.4)*
8. **Submit** the per-flight NAV CANADA RPAS Flight Authorization and wait for **Accepted** before flying. *(items 3.2, 3.3)*
9. **Establish** the record-keeping structure (flight log, maintenance log, incident log). *(items 7.1, 7.2, 7.3)*

Items 4.1 (SFOC-RPAS) and 4.2 (RPOC) do **not** need to be in place for the delivered Sheltered profile; they become mandatory only if the City later chooses to expand into Level 1 Complex or lower-risk BVLOS operations.

---

## 12. Primary reference index

- **Transport Canada — Drone safety hub:** <https://tc.canada.ca/en/aviation/drone-safety>
- **Getting a drone pilot certificate:** <https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/getting-drone-pilot-certificate>
- **Register your drone:** <https://tc.canada.ca/en/aviation/drone-safety/drone-safety-tips-rules/register-your-drone>
- **Drone Management Portal (registration + RPOC + declarations):** <https://tc.canada.ca/en/aviation/drone-safety/drone-management-portal>
- **Advanced Operations category:** <https://tc.canada.ca/en/aviation/drone-safety/learn-rules-you-fly-your-drone/drone-operation-categories-pilot-certificates/advanced-operations>
- **Level 1 Complex Operations:** <https://tc.canada.ca/en/aviation/drone-safety/learn-rules-you-fly-your-drone/drone-operation-categories-pilot-certificates/level-1-complex-operations>
- **Apply for an RPOC:** <https://tc.canada.ca/en/aviation/drone-safety/drone-pilot-licensing/apply-rpas-operator-certificate-rpoc>
- **Safety Assurance Declarations:** <https://tc.canada.ca/en/aviation/drone-safety/submitting-drone-safety-assurance-declaration>
- **2025 summary of changes to Canada's drone regulations:** <https://tc.canada.ca/en/aviation/drone-safety/2025-summary-changes-canada-drone-regulations>
- **SFOC-RPAS overview / AC 903-002:** <https://tc.canada.ca/en/aviation/reference-centre/advisory-circulars/advisory-circular-ac-no-903-002>
- **Report a drone incident:** <https://tc.canada.ca/en/aviation/drone-safety/report-drone-incident>
- **Canadian Aviation Regulations (CARs) Part IX:** <https://laws-lois.justice.gc.ca/eng/regulations/sor-96-433/section-900.01.html>
- **NAV Drone (authorization portal):** <https://www.navdrone.ca/>
- **NAV CANADA — NAV Drone overview:** <https://www.navcanada.ca/en/nav-drone-mobile-geozones-and-notams.aspx>
- **NAV CANADA NOTAMs:** <https://plan.navcanada.ca/wxrecall/>
- **Transportation Safety Board (accident reporting):** <https://www.bst.gc.ca/eng/incidents-occurrence/aviation/index.html>
- **CADORS Manual (TP 4044):** <https://tc.canada.ca/en/aviation/aviation-publications/civil-aviation-daily-occurrence-reporting-system-cadors-manual-tp-4044>

---

*Prepared as part of the UAV-RT WebApp handover package. This checklist reflects the regulatory position at the date below and should be reviewed at least annually or whenever Transport Canada publishes an amendment to CARs Part IX or the associated Standards.*

*Last updated: 2026-09-15.*
