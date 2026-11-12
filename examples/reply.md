# Example: the slow invoice page

A realistic agent reply from a coding session, used to show what earshot turns it into. Nothing in it is private: no hostnames, paths, accounts or brief ids.

```
Fixed the slow invoice page. It ran one query for the invoice list and then one more per invoice to load its customer name, 201 queries for a page of 200 invoices, and each query waited for the previous one. It now loads the invoices and all their customers in one joined query. Measured on the staging copy with 200 invoices: the page went from 1.8 s to 240 ms, and database queries per page from 201 to 1. The join uses the existing customer index, so no migration is needed. 48 tests pass.
```
