# Words used in the UI (Thai first, then English)

Use ONE word per idea in every screen, tooltip, toast and manifest string. Add a row here before inventing a new word.

| Idea | Thai (the one word) | English | One-line meaning for the user |
|---|---|---|---|
| Save tabs to the list and close them | เก็บ / เก็บแท็บ | save | Put the open tabs in the list, then close them to free RAM. |
| The list page | รายการที่เก็บไว้ | the list / saved list | Where all saved tabs live. |
| One saved batch of tabs | ชุดแท็บ (never "เซสชัน", never "กลุ่ม") | tab set | The tabs saved together in one go. |
| One saved page inside a tab set | แท็บ (use "ลิงก์" only when copying/importing/exporting) | tab | One saved page. |
| Chrome's coloured tab group | กลุ่มแท็บของ Chrome (short: กลุ่มแท็บ) | Chrome tab group | The coloured group in Chrome's tab bar. |
| Suspend / discard | พักแท็บ / พักอยู่ | sleep / sleeping tab | The tab stays in the tab bar but uses no RAM until you click it (the page reloads). |
| Reopen a saved tab or tab set | เปิด / เปิดกลับ | open / reopen | Open it again in Chrome. |
| Bring back from the trash or recovery list | กู้คืน | restore / put back | Return it to the list. |
| Trash | ถังขยะ | trash | Deleted items wait here until the time limit, then are deleted for good. |
| Permanent delete | ลบถาวร (+ "ลบแล้วเอากลับมาไม่ได้") | delete for good | Cannot be undone. |
| Second copy of the data | สำเนาสำรอง | backup copy | An automatic copy kept inside the extension. |
| Export / import file | ส่งออก / นำเข้า | export / import | Move data out or in as a file or text. |
| Recover tabs after a crash | กู้คืนแท็บที่หาย | Recover lost tabs | Restore tabs from the notes the extension makes every few minutes. |
| Search index | ตัวช่วยค้นหา | search helper | Makes search fast; rebuilt when needed. |
| Sync | ซิงค์ระหว่างเครื่อง | sync between devices | Send tab sets to your other Chrome browsers (encrypted). |
| Two tabs side by side (Chrome split view) | แบ่งหน้าจอ (split view) | split view | Two tabs shown next to each other in one Chrome window; saved and reopened as a pair. |
| Duplicate tabs | แท็บซ้ำ | duplicate tabs | Two tabs with the same page. |
| Tidy up | จัดระเบียบแท็บ | tidy up tabs | Close duplicates, handle Chrome internal pages, sleep idle tabs. |
| Chrome internal pages | หน้าภายในของ Chrome (เช่น chrome://settings) | Chrome internal pages | Pages that belong to Chrome itself. |
| RAM saver | โหมดประหยัดแรม | RAM saver mode | The extension works lighter because free RAM is low. |
| Archive | คลัง (action: ย้ายเข้าคลัง) | archive | Hide a tab set from the main list without deleting it. |
| Pin / star / lock / to do | ปักหมุด / ติดดาว / ล็อก / งานค้าง | pin / star / lock / to do | Lock stops accidental delete or removal. |
| Recommended choice | " · แนะนำ" | " · recommended" | Marks the safest default in a dropdown. |

## Units and style

- Time: วินาที, นาที, ชั่วโมง, วัน (never a bare number for minutes, never "ms").
- Size: "ประมาณ 4 MB" / "about 4 MB".
- Counts always say what is counted: "12 แท็บ", "3 ชุดแท็บ".
- Confirm dialogs for deleting state the exact counts and say "ลบแล้วเอากลับมาไม่ได้" or that it can be undone.
- Errors say what went wrong and what to do next ("ลองใหม่", "รีเฟรชหน้านี้").
- Never show internal names to users: discard, drain, vault, index log, atlas, tombstone, PBKDF2, epoch, outbox, host (use "เว็บไซต์"), session (use "ชุดแท็บ").
