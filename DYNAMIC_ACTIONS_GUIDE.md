# Dynamic Actions Column - Visual Guide

## What Changed

The Actions column now shows **different content based on the device's licence status**, making it clear what state the device is in and what action you can take.

---

## Visual States

### 1. 🟢 Active Device
```
┌─────────────────────┐
│  ✅ Active          │
│                     │
│  ⏸ Suspend         │
└─────────────────────┘
```
**When:** Device has an active licence
**Shows:** Green "Active" badge + Red "Suspend" button
**Action:** Click to suspend the device

---

### 2. 🟡 Suspended Device
```
┌─────────────────────┐
│  ⚠️ Suspended       │
│                     │
│  ✓ Reactivate      │
└─────────────────────┘
```
**When:** Device has been suspended by admin
**Shows:** Yellow "Suspended" badge + Green "Reactivate" button
**Action:** Click to reactivate the device

---

### 3. 🔴 Expired Licence
```
┌─────────────────────┐
│  ⏰ Expired         │
│                     │
│  🔄 Renew          │
└─────────────────────┘
```
**When:** Device licence has expired
**Shows:** Red "Expired" badge + Green "Renew" button
**Action:** Click to renew the licence

---

### 4. ⚪ No Licence
```
┌─────────────────────┐
│  ⚪ No Licence      │
│                     │
│  ➕ Activate       │
└─────────────────────┘
```
**When:** Device has no licence assigned
**Shows:** Gray "No Licence" badge + Green "Activate" button
**Action:** Click to activate a new licence

---

## Color Coding

| Status | Badge Color | Button Color | Meaning |
|--------|-------------|--------------|---------|
| Active | 🟢 Green | 🔴 Red | Good state, can suspend if needed |
| Suspended | 🟡 Yellow | 🟢 Green | Warning state, can reactivate |
| Expired | 🔴 Red | 🟢 Green | Problem state, needs renewal |
| No Licence | ⚪ Gray | 🟢 Green | Neutral state, can activate |

---

## How It Works

### Automatic Detection
The system checks `licence_status` field for each device and automatically shows the appropriate status and action.

### One Action Per State
- **Active → Suspend** (remove access)
- **Suspended → Reactivate** (restore access)
- **Expired → Renew** (extend licence)
- **No Licence → Activate** (grant access)

### Visual Feedback
1. **Status Badge:** Clearly shows current state with icon and text
2. **Action Button:** Shows only the relevant action you can take
3. **Color Coding:** Green = positive action, Red = cautionary action
4. **Icons:** Universal symbols for quick recognition

---

## User Workflow

### Example: Suspending an Active Device
1. Find device row with "✅ Active" badge
2. Click red "⏸ Suspend" button
3. Confirm action in dialog
4. Page refreshes
5. Row now shows "⚠️ Suspended" + "✓ Reactivate" button

### Example: Reactivating a Suspended Device
1. Find device row with "⚠️ Suspended" badge
2. Click green "✓ Reactivate" button
3. Confirm action in dialog
4. Page refreshes
5. Row now shows "✅ Active" + "⏸ Suspend" button

---

## Benefits

### ✅ Clear Status at a Glance
No need to look at other columns - the Actions column tells you everything

### ✅ Contextual Actions
Only see actions that make sense for the current state

### ✅ No Confusion
Can't accidentally activate an already-active device or suspend a suspended one

### ✅ Professional Appearance
Modern UI pattern used by leading SaaS platforms

### ✅ Mobile-Friendly
Status and action stacked vertically works well on all screen sizes

---

## Implementation Applied To

- ✅ **Devices Table** (Registered Devices tab)
- ✅ **Licences Table** (Licences tab)
- ⏳ Payments Table (static, no actions needed)

---

## Technical Notes

### Status Values Handled
- `active` - Shows Active badge + Suspend button
- `suspended` - Shows Suspended badge + Reactivate button
- `expired` - Shows Expired badge + Renew button
- `null` or `undefined` - Shows No Licence badge + Activate button

### CSS Classes Used
- `.badge.b-active` - Green background for active status
- `.badge.b-suspended` - Yellow background for suspended status
- `.badge.b-expired` - Red background for expired status
- `.badge.b-none` - Gray background for no licence
- `.act-btn.act-activate` - Green button styling
- `.act-btn.act-suspend` - Red button styling

### JavaScript Functions
- `adminAction('activate', deviceId)` - Activates/reactivates device
- `adminAction('suspend', deviceId)` - Suspends device

---

## Future Enhancements

Possible additions:
- [ ] Bulk actions (suspend/activate multiple devices)
- [ ] Quick renewal with plan selection dropdown
- [ ] Confirmation dialog with more details
- [ ] Activity log showing status change history
- [ ] Scheduled suspension (suspend after X days)

---

## Support

If you see an unexpected status or button:
1. Check the device's `licence_status` field in the database
2. Verify the status is one of: active, suspended, expired, or null
3. Refresh the page to reload data
4. Check console for any JavaScript errors

---

**Last Updated:** 2026-10-14  
**Version:** 2.1 (Dynamic Actions)
